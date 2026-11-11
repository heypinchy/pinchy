/**
 * Real-DB integration tests for listUnsearchableDocuments() (#935): the
 * documents an index run produced a row for but no searchable text from.
 *
 * These belong against a real PostgreSQL database rather than a mocked query
 * builder, because every way this feature can be wrong is a way the SQL can be
 * wrong: an inner join instead of a left join lists nothing (or everything) and
 * still looks plausible, and a prefix filter that forgets to escape LIKE
 * metacharacters silently widens an agent's scope. Neither mistake is visible
 * from a mock that returns whatever it was told to.
 *
 * Rows are inserted directly (no ingest, no embedder) — a chunk's `embedding`
 * is nullable, and nothing here ranks anything.
 */
import { expect, it } from "vitest";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import { EXTRACTION_VERSION } from "@/lib/knowledge/ingest";
import type { KbOcrAvailability } from "@/lib/knowledge/kb-ocr";
import { OFFICE_ARTIFACT_FORMAT_VERSION } from "@/lib/knowledge/office-artifacts";
import {
  listUnsearchableDocuments,
  summarizeUnsearchableDocuments,
  unsearchableDocumentPages,
  type UnsearchableDocument,
} from "@/lib/knowledge/unsearchable";

const ORG_ID = "org-kb-unsearchable-test";

const OCR_OFF: KbOcrAvailability = { state: "off" };
const NO_MODEL: KbOcrAvailability = { state: "no_model" };
const OCR_ON: KbOcrAvailability = { state: "on", model: "anthropic/claude-haiku-4-5" };

/** Inserts a kb_documents row with NO chunks — what an unsearchable (or unconverted) document looks like in the database. */
async function seedUnsearchable(
  sourcePath: string,
  status: "active" | "archived" = "active",
  emptyExtractionBy: string | null = null
): Promise<string> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId: ORG_ID,
      contentHash: `hash-${sourcePath}`,
      sourcePath,
      status,
      emptyExtractionBy,
    })
    .returning();
  return doc.id;
}

/** What ingest records on an empty read by `reader` (ingest.ts, extractionRecord). */
const readBy = (reader: string) => `${EXTRACTION_VERSION}|${reader}`;

/** Inserts a kb_documents row WITH one chunk — a document that answers questions. */
async function seedReadable(
  sourcePath: string,
  artifactFormatVersion: number | null = null
): Promise<void> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({ orgId: ORG_ID, contentHash: `hash-${sourcePath}`, sourcePath, artifactFormatVersion })
    .returning();
  await db.insert(kbChunks).values({
    documentId: doc.id,
    orgId: ORG_ID,
    sourcePath,
    chunkText: "Some extracted text.",
    locator: { kind: "page", page: 1 },
  });
}

const paths = (result: { documents: { sourcePath: string }[] }) =>
  result.documents.map((d) => d.sourcePath);

const list = (allowedPaths: string[], opts?: Parameters<typeof listUnsearchableDocuments>[3]) =>
  listUnsearchableDocuments(ORG_ID, allowedPaths, NO_MODEL, opts);

it("lists exactly the documents that have a row and no chunks", async () => {
  await seedUnsearchable("/data/certs/AFNOR validation.pdf");
  await seedReadable("/data/certs/Datasheet.pdf");

  const result = await list(["/data/certs"]);

  expect(paths(result)).toEqual(["/data/certs/AFNOR validation.pdf"]);
  expect(result.total).toBe(1);
});

// The left-join trap named in #935: an INNER join would list nothing at all
// here, and an unfiltered join would list this document once per chunk. Two
// chunks make both mistakes visible; one chunk hides the second.
it("never lists a document that has chunks, not even once per chunk", async () => {
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId: ORG_ID,
      contentHash: "hash-multi",
      sourcePath: "/data/certs/Handbook.pdf",
    })
    .returning();
  await db.insert(kbChunks).values([
    {
      documentId: doc.id,
      orgId: ORG_ID,
      sourcePath: "/data/certs/Handbook.pdf",
      chunkText: "Page one.",
      locator: { kind: "page", page: 1 },
    },
    {
      documentId: doc.id,
      orgId: ORG_ID,
      sourcePath: "/data/certs/Handbook.pdf",
      chunkText: "Page two.",
      locator: { kind: "page", page: 2 },
    },
  ]);

  const result = await list(["/data/certs"]);

  expect(result.documents).toEqual([]);
  expect(result.total).toBe(0);
});

it("does not list unsearchable documents outside the agent's granted directories", async () => {
  await seedUnsearchable("/data/hr/Scanned contract.pdf");
  await seedUnsearchable("/data/legal/Scanned NDA.pdf");

  const result = await list(["/data/hr"]);

  expect(paths(result)).toEqual(["/data/hr/Scanned contract.pdf"]);
});

// Same separator-boundary reasoning as retrieval's path filter: a grant on
// "/data/hr" must not reach into a sibling folder whose name merely starts
// with it.
it("treats a grant as a directory boundary, not a string prefix", async () => {
  await seedUnsearchable("/data/hr-archive/Scan.pdf");
  await seedUnsearchable("/data/hr/Scan.pdf");

  const result = await list(["/data/hr"]);

  expect(paths(result)).toEqual(["/data/hr/Scan.pdf"]);
});

// "_" is a single-character LIKE wildcard. Unescaped, a grant on "/data/hr_eu"
// would also match "/data/hrxeu" — a real folder-naming pattern turning into a
// scope bypass.
it("escapes LIKE metacharacters in a granted path", async () => {
  await seedUnsearchable("/data/hr_eu/Scan.pdf");
  await seedUnsearchable("/data/hrxeu/Scan.pdf");

  const result = await list(["/data/hr_eu"]);

  expect(paths(result)).toEqual(["/data/hr_eu/Scan.pdf"]);
});

it("lists a document granted by its exact path, not only by its parent directory", async () => {
  await seedUnsearchable("/data/certs/AFNOR validation.pdf");
  await seedUnsearchable("/data/certs/NordVal.pdf");

  const result = await list(["/data/certs/AFNOR validation.pdf"]);

  expect(paths(result)).toEqual(["/data/certs/AFNOR validation.pdf"]);
});

// Denies by default, exactly as retrieve() does: an agent granted nothing sees
// nothing — never "everything, because there is no filter to apply".
it("returns nothing when the agent is granted no directories", async () => {
  await seedUnsearchable("/data/hr/Scan.pdf");

  expect(await list([])).toEqual({ documents: [], total: 0 });
  expect(await summarizeUnsearchableDocuments(ORG_ID, [], NO_MODEL)).toEqual({
    total: 0,
    totals: { no_text: 0, awaiting_conversion: 0 },
    causes: { ocr_off: 0, no_vision_model: 0, read_next_run: 0, read_blank: 0 },
    groups: [],
  });
  const pages = [];
  for await (const page of unsearchableDocumentPages(ORG_ID, [], NO_MODEL)) pages.push(page);
  expect(pages).toEqual([]);
});

it("never crosses the org boundary", async () => {
  await seedUnsearchable("/data/hr/Scan.pdf");
  await db.insert(kbDocuments).values({
    orgId: "org-somebody-else",
    contentHash: "hash-other",
    sourcePath: "/data/hr/Other org scan.pdf",
  });

  const result = await list(["/data/hr"]);

  expect(paths(result)).toEqual(["/data/hr/Scan.pdf"]);
});

// kb_chunks denormalizes source_path from its parent document, so "has text?"
// could be asked by path (as the exploratory query in #935 did) or by
// document_id. They disagree exactly when two DOCUMENTS share a path — which
// (org_id, source_path) being unique makes an ACL duplicate across orgs. The
// join is on document_id, and this pins it: another document's chunk must
// never make this one look readable.
it("decides per document, not per path", async () => {
  const [foreignDoc] = await db
    .insert(kbDocuments)
    .values({
      orgId: "org-somebody-else",
      contentHash: "hash-shared",
      sourcePath: "/data/certs/Shared name.pdf",
    })
    .returning();
  await db.insert(kbChunks).values({
    documentId: foreignDoc.id,
    orgId: ORG_ID,
    sourcePath: "/data/certs/Shared name.pdf",
    chunkText: "Text belonging to the other document.",
    locator: { kind: "page", page: 1 },
  });
  await seedUnsearchable("/data/certs/Shared name.pdf");

  const result = await list(["/data/certs"]);

  expect(paths(result)).toEqual(["/data/certs/Shared name.pdf"]);
});

it("orders active documents before archived ones, then by path", async () => {
  await seedUnsearchable("/data/certs/OLD/Expired ISO.pdf", "archived");
  await seedUnsearchable("/data/certs/NordVal.pdf");
  await seedUnsearchable("/data/certs/AFNOR.pdf");

  const result = await list(["/data/certs"]);

  expect(result.documents.map(({ sourcePath, status }) => ({ sourcePath, status }))).toEqual([
    { sourcePath: "/data/certs/AFNOR.pdf", status: "active" },
    { sourcePath: "/data/certs/NordVal.pdf", status: "active" },
    { sourcePath: "/data/certs/OLD/Expired ISO.pdf", status: "archived" },
  ]);
});

// A corpus can hold more unsearchable documents than a panel should render. The
// cap truncates the list, never the count — a "showing 2 of 5" is honest, a
// silent "2" would understate the gap it exists to expose.
it("caps the returned list but reports the true total", async () => {
  for (const n of [1, 2, 3, 4, 5]) {
    await seedUnsearchable(`/data/certs/Scan ${n}.pdf`);
  }

  const result = await list(["/data/certs"], { limit: 2 });

  expect(paths(result)).toEqual(["/data/certs/Scan 1.pdf", "/data/certs/Scan 2.pdf"]);
  expect(result.total).toBe(5);
});

// Search leaves out an Office document whose chunks were read from an artifact
// of an earlier format until it is converted again (retrieve.ts). It HAS
// chunks, so "no chunk" alone would list it nowhere: neither found by a search
// nor named as a document that cannot be — the silent gap this list closes.
it("lists an Office document search leaves out until it is converted again, and says so", async () => {
  await seedReadable("/data/offers/Angebot.docx");
  await seedReadable("/data/offers/Current.pptx", OFFICE_ARTIFACT_FORMAT_VERSION);
  await seedReadable("/data/offers/Handbook.pdf");
  await seedUnsearchable("/data/offers/Scan.pdf");

  const result = await list(["/data/offers"]);

  expect(result.documents.map(({ sourcePath, reason }) => ({ sourcePath, reason }))).toEqual([
    { sourcePath: "/data/offers/Angebot.docx", reason: "awaiting_conversion" },
    { sourcePath: "/data/offers/Scan.pdf", reason: "no_text" },
  ]);
  expect(result.total).toBe(2);
});

// The two reasons call for different words — one is a scan nothing can read
// yet, the other a file with text that is about to be converted again — so a
// surface has to be able to count each. Counted over the whole scope, like
// `total`: a page that happens to hold only scans must not report zero files
// waiting to be converted.
it("counts each reason over the whole scope, not over the returned page", async () => {
  for (const n of [1, 2, 3]) {
    await seedUnsearchable(`/data/mixed/A scan ${n}.pdf`);
  }
  await seedReadable("/data/mixed/Z offer.docx");
  await seedReadable("/data/mixed/Z deck.pptx");

  const page = await list(["/data/mixed"], { limit: 2 });
  const summary = await summarizeUnsearchableDocuments(ORG_ID, ["/data/mixed"], NO_MODEL);

  expect(paths(page)).toEqual(["/data/mixed/A scan 1.pdf", "/data/mixed/A scan 2.pdf"]);
  expect(page.total).toBe(5);
  expect(summary.total).toBe(5);
  expect(summary.totals).toEqual({ no_text: 3, awaiting_conversion: 2 });
});

// ── Where a document sits (#1364) ──────────────────────────────────────────
//
// On a real share the full path is mostly the same long prefix — the mount —
// and the file name, the part an admin recognizes, is at the far end. So each
// document carries its name and its folder relative to the grant it sits
// under, and the list can be grouped by the first folder below that grant.

it("names each document and its folder relative to the grant it sits under", async () => {
  await seedUnsearchable("/data/share/Quality/Certificates/2024/AFNOR.pdf");
  await seedUnsearchable("/data/share/Readme scan.pdf");

  const result = await list(["/data/share"]);

  expect(result.documents.map(({ root, folder, name }) => ({ root, folder, name }))).toEqual([
    { root: "/data/share", folder: "Quality/Certificates/2024", name: "AFNOR.pdf" },
    { root: "/data/share", folder: "", name: "Readme scan.pdf" },
  ]);
});

// Nested grants: "/data/share" and "/data/share/Quality" both cover a file in
// Quality. It belongs to the narrower one — that is the folder the admin
// granted with that file in mind, and counting it under both would make the
// groups add up to more than the total.
it("places a document under the narrowest grant that covers it", async () => {
  await seedUnsearchable("/data/share/Quality/Certificates/AFNOR.pdf");

  const result = await list(["/data/share", "/data/share/Quality"]);

  expect(result.documents.map(({ root, folder }) => ({ root, folder }))).toEqual([
    { root: "/data/share/Quality", folder: "Certificates" },
  ]);
});

it("reads a grant written with a trailing slash as the same folder", async () => {
  await seedUnsearchable("/data/share/Quality/AFNOR.pdf");

  const result = await list(["/data/share/"]);

  expect(result.documents.map(({ root, folder }) => ({ root, folder }))).toEqual([
    { root: "/data/share", folder: "Quality" },
  ]);
});

it("groups the scope by the first folder below each grant, with a count per group", async () => {
  for (const n of [1, 2, 3]) await seedUnsearchable(`/data/share/Quality/Scan ${n}.pdf`);
  await seedUnsearchable("/data/share/Quality/Deep/Nested/Scan.pdf");
  await seedUnsearchable("/data/share/Sales/Scan.pdf");
  await seedUnsearchable("/data/share/Loose scan.pdf");
  await seedUnsearchable("/data/legal/NDA scan.pdf");
  await seedReadable("/data/share/Sales/Datasheet.pdf");

  const summary = await summarizeUnsearchableDocuments(
    ORG_ID,
    ["/data/share", "/data/legal"],
    NO_MODEL
  );

  // Largest first: the folder holding most of the gap is where an admin looks.
  expect(summary.groups).toEqual([
    { root: "/data/share", folder: "Quality", count: 4 },
    { root: "/data/legal", folder: null, count: 1 },
    { root: "/data/share", folder: null, count: 1 },
    { root: "/data/share", folder: "Sales", count: 1 },
  ]);
  expect(summary.total).toBe(7);
});

it("lists one group on request, with that group's own count", async () => {
  for (const n of [1, 2, 3]) await seedUnsearchable(`/data/share/Quality/Scan ${n}.pdf`);
  await seedUnsearchable("/data/share/Quality/Deep/Scan.pdf");
  await seedUnsearchable("/data/share/Sales/Scan.pdf");
  await seedUnsearchable("/data/share/Loose scan.pdf");

  const quality = await list(["/data/share"], {
    limit: 2,
    group: { root: "/data/share", folder: "Quality" },
  });
  const topLevel = await list(["/data/share"], { group: { root: "/data/share", folder: null } });

  expect(paths(quality)).toEqual([
    "/data/share/Quality/Deep/Scan.pdf",
    "/data/share/Quality/Scan 1.pdf",
  ]);
  expect(quality.total).toBe(4);
  expect(paths(topLevel)).toEqual(["/data/share/Loose scan.pdf"]);
  expect(topLevel.total).toBe(1);
});

// A group is named by its grant, and a grant the agent doesn't hold is no
// group of this agent's: asking for one must not widen the scope past the
// allow-list, whatever the caller passes.
it("answers nothing for a group outside the agent's grants", async () => {
  await seedUnsearchable("/data/legal/NDA scan.pdf");

  const result = await list(["/data/share"], { group: { root: "/data/legal", folder: null } });

  expect(result).toEqual({ documents: [], total: 0 });
});

// "_" and "%" in a folder name are ordinary characters in a group, not LIKE
// wildcards: the group match is by equality, so "Q_A" never answers for "QxA".
it("matches a group's folder exactly, not as a pattern", async () => {
  await seedUnsearchable("/data/share/Q_A/Scan.pdf");
  await seedUnsearchable("/data/share/QxA/Scan.pdf");

  const result = await list(["/data/share"], { group: { root: "/data/share", folder: "Q_A" } });

  expect(paths(result)).toEqual(["/data/share/Q_A/Scan.pdf"]);
});

// ── Why a document holds no text (#1362) ───────────────────────────────────
//
// The index records which reader came back empty (`empty_extraction_by`), and
// the server knows whether a vision model would read scans right now. Together
// they say what an admin can do about each document — so the server answers
// it, rather than the page guessing one reason for all of them.

it("says a scan read without a vision model waits on OCR being switched on, when it is off", async () => {
  await seedUnsearchable("/data/share/Scan.pdf", "active", readBy("no-ocr"));

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/share"], OCR_OFF);

  expect(result.documents[0].cause).toBe("ocr_off");
});

it("says a scan read without a vision model waits on one, when none is available", async () => {
  await seedUnsearchable("/data/share/Scan.pdf", "active", readBy("no-ocr"));

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/share"], NO_MODEL);

  expect(result.documents[0].cause).toBe("no_vision_model");
});

it("says the next run reads a scan once a vision model is available", async () => {
  await seedUnsearchable("/data/share/Scan.pdf", "active", readBy("no-ocr"));

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/share"], OCR_ON);

  expect(result.documents[0].cause).toBe("read_next_run");
});

// A vision model looked and found nothing: a blank page, a photo without
// words. Switching anything on or off changes nothing for it, so none of the
// OCR hints may claim it.
it("says a document the vision model already read holds no text, whatever OCR is now", async () => {
  await seedUnsearchable(
    "/data/share/Blank.pdf",
    "active",
    readBy("ocr:anthropic/claude-haiku-4-5")
  );

  for (const ocr of [OCR_OFF, NO_MODEL, OCR_ON]) {
    const result = await listUnsearchableDocuments(ORG_ID, ["/data/share"], ocr);
    expect(result.documents[0].cause).toBe("read_blank");
  }
});

// Ingest reads it again when the model changes (couldReadDifferently), so
// "holds no text" would be premature.
it("says the next run reads it again when a different vision model is available now", async () => {
  await seedUnsearchable("/data/share/Faint.pdf", "active", readBy("ocr:some/older-model"));

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/share"], OCR_ON);

  expect(result.documents[0].cause).toBe("read_next_run");
});

it("says a spreadsheet or converted Office file read in full holds no text", async () => {
  await seedUnsearchable("/data/share/Empty.xlsx", "active", readBy("sheets"));
  // Converted under the current rules — an older artifact would be waiting
  // for a conversion instead, which is the other reason.
  await db.insert(kbDocuments).values({
    orgId: ORG_ID,
    contentHash: "hash-empty-docx",
    sourcePath: "/data/share/Empty.docx",
    emptyExtractionBy: readBy("converter"),
    artifactFormatVersion: OFFICE_ARTIFACT_FORMAT_VERSION,
  });

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/share"], OCR_OFF);

  expect(result.documents.map((d) => d.cause)).toEqual(["read_blank", "read_blank"]);
});

// No record: a document indexed before the record existed, or one whose read
// did not finish. Ingest reads it again on the next run (it skips only a
// document on record as empty), with whatever OCR the server has then — so
// it waits on exactly what a scan read without OCR waits on. The same holds
// for a record an older extractor wrote.
it("treats a document with no record, or an outdated one, like a scan read without OCR", async () => {
  await seedUnsearchable("/data/share/A legacy.pdf", "active", null);
  await seedUnsearchable(
    "/data/share/B outdated.pdf",
    "active",
    `${EXTRACTION_VERSION - 1}|sheets`
  );

  const off = await listUnsearchableDocuments(ORG_ID, ["/data/share"], OCR_OFF);
  const on = await listUnsearchableDocuments(ORG_ID, ["/data/share"], OCR_ON);

  expect(off.documents.map((d) => d.cause)).toEqual(["ocr_off", "ocr_off"]);
  expect(on.documents.map((d) => d.cause)).toEqual(["read_next_run", "read_next_run"]);
});

it("gives a document waiting to be converted again no OCR cause", async () => {
  await seedReadable("/data/share/Angebot.docx");

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/share"], OCR_OFF);

  expect(result.documents[0]).toMatchObject({ reason: "awaiting_conversion", cause: null });
});

it("counts each cause over the whole scope", async () => {
  for (const n of [1, 2, 3]) {
    await seedUnsearchable(`/data/share/Scan ${n}.pdf`, "active", readBy("no-ocr"));
  }
  await seedUnsearchable(
    "/data/share/Blank.pdf",
    "active",
    readBy("ocr:anthropic/claude-haiku-4-5")
  );
  await seedReadable("/data/share/Angebot.docx");

  const summary = await summarizeUnsearchableDocuments(ORG_ID, ["/data/share"], OCR_OFF);

  expect(summary.causes).toEqual({
    ocr_off: 3,
    no_vision_model: 0,
    read_next_run: 0,
    read_blank: 1,
  });
  expect(summary.totals).toEqual({ no_text: 4, awaiting_conversion: 1 });
});

// ── The full list, for the download (#1364) ────────────────────────────────

it("pages through the whole scope in path order, with nothing lost or repeated between pages", async () => {
  const expected: string[] = [];
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    const path = `/data/share/Folder ${n % 3}/Scan ${n}.pdf`;
    await seedUnsearchable(path, n === 2 ? "archived" : "active", readBy("no-ocr"));
    expected.push(path);
  }
  await seedReadable("/data/share/Readable.pdf");
  await seedUnsearchable("/data/legal/Outside.pdf");

  const pages: UnsearchableDocument[][] = [];
  for await (const page of unsearchableDocumentPages(ORG_ID, ["/data/share"], OCR_OFF, {
    pageSize: 3,
  })) {
    pages.push(page);
  }

  expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
  expect(pages.flat().map((d) => d.sourcePath)).toEqual([...expected].sort());
  expect(pages.flat().every((d) => d.cause === "ocr_off")).toBe(true);
  expect(pages.flat().find((d) => d.name === "Scan 2.pdf")).toMatchObject({
    status: "archived",
    folder: "Folder 2",
  });
});

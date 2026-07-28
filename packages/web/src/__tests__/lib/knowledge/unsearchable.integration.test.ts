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
import { listUnsearchableDocuments } from "@/lib/knowledge/unsearchable";

const ORG_ID = "org-kb-unsearchable-test";

/** Inserts a kb_documents row with NO chunks — what an unsearchable (or unconverted) document looks like in the database. */
async function seedUnsearchable(
  sourcePath: string,
  status: "active" | "archived" = "active"
): Promise<string> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({ orgId: ORG_ID, contentHash: `hash-${sourcePath}`, sourcePath, status })
    .returning();
  return doc.id;
}

/** Inserts a kb_documents row WITH one chunk — a document that answers questions. */
async function seedReadable(sourcePath: string): Promise<void> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({ orgId: ORG_ID, contentHash: `hash-${sourcePath}`, sourcePath })
    .returning();
  await db.insert(kbChunks).values({
    documentId: doc.id,
    orgId: ORG_ID,
    sourcePath,
    chunkText: "Some extracted text.",
    page: 1,
  });
}

const paths = (result: { documents: { sourcePath: string }[] }) =>
  result.documents.map((d) => d.sourcePath);

it("lists exactly the documents that have a row and no chunks", async () => {
  await seedUnsearchable("/data/certs/AFNOR validation.pdf");
  await seedReadable("/data/certs/Datasheet.pdf");

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/certs"]);

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
      page: 1,
    },
    {
      documentId: doc.id,
      orgId: ORG_ID,
      sourcePath: "/data/certs/Handbook.pdf",
      chunkText: "Page two.",
      page: 2,
    },
  ]);

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/certs"]);

  expect(result.documents).toEqual([]);
  expect(result.total).toBe(0);
});

it("does not list unsearchable documents outside the agent's granted directories", async () => {
  await seedUnsearchable("/data/hr/Scanned contract.pdf");
  await seedUnsearchable("/data/legal/Scanned NDA.pdf");

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/hr"]);

  expect(paths(result)).toEqual(["/data/hr/Scanned contract.pdf"]);
});

// Same separator-boundary reasoning as retrieval's path filter: a grant on
// "/data/hr" must not reach into a sibling folder whose name merely starts
// with it.
it("treats a grant as a directory boundary, not a string prefix", async () => {
  await seedUnsearchable("/data/hr-archive/Scan.pdf");
  await seedUnsearchable("/data/hr/Scan.pdf");

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/hr"]);

  expect(paths(result)).toEqual(["/data/hr/Scan.pdf"]);
});

// "_" is a single-character LIKE wildcard. Unescaped, a grant on "/data/hr_eu"
// would also match "/data/hrxeu" — a real folder-naming pattern turning into a
// scope bypass.
it("escapes LIKE metacharacters in a granted path", async () => {
  await seedUnsearchable("/data/hr_eu/Scan.pdf");
  await seedUnsearchable("/data/hrxeu/Scan.pdf");

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/hr_eu"]);

  expect(paths(result)).toEqual(["/data/hr_eu/Scan.pdf"]);
});

it("lists a document granted by its exact path, not only by its parent directory", async () => {
  await seedUnsearchable("/data/certs/AFNOR validation.pdf");
  await seedUnsearchable("/data/certs/NordVal.pdf");

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/certs/AFNOR validation.pdf"]);

  expect(paths(result)).toEqual(["/data/certs/AFNOR validation.pdf"]);
});

// Denies by default, exactly as retrieve() does: an agent granted nothing sees
// nothing — never "everything, because there is no filter to apply".
it("returns nothing when the agent is granted no directories", async () => {
  await seedUnsearchable("/data/hr/Scan.pdf");

  const result = await listUnsearchableDocuments(ORG_ID, []);

  expect(result).toEqual({ documents: [], total: 0 });
});

it("never crosses the org boundary", async () => {
  await seedUnsearchable("/data/hr/Scan.pdf");
  await db.insert(kbDocuments).values({
    orgId: "org-somebody-else",
    contentHash: "hash-other",
    sourcePath: "/data/hr/Other org scan.pdf",
  });

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/hr"]);

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
    page: 1,
  });
  await seedUnsearchable("/data/certs/Shared name.pdf");

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/certs"]);

  expect(paths(result)).toEqual(["/data/certs/Shared name.pdf"]);
});

it("orders active documents before archived ones, then by path", async () => {
  await seedUnsearchable("/data/certs/OLD/Expired ISO.pdf", "archived");
  await seedUnsearchable("/data/certs/NordVal.pdf");
  await seedUnsearchable("/data/certs/AFNOR.pdf");

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/certs"]);

  expect(result.documents).toEqual([
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

  const result = await listUnsearchableDocuments(ORG_ID, ["/data/certs"], { limit: 2 });

  expect(paths(result)).toEqual(["/data/certs/Scan 1.pdf", "/data/certs/Scan 2.pdf"]);
  expect(result.total).toBe(5);
});

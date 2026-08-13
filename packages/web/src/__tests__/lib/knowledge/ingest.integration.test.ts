/**
 * Real-DB integration tests for ingestDirectory() (discover -> extract ->
 * chunk -> embed -> upsert). Uses a real PostgreSQL test database
 * (provisioned by global-setup.ts, truncated between tests by setup.ts) plus
 * real filesystem I/O against a per-test temp directory. The embedder and
 * PDF extractor are dependency-injected fakes (deterministic 768-dim
 * vectors, canned page text) so the suite stays hermetic — no Ollama, no
 * real PDF parsing — and exercises the orchestration + idempotency/staleness
 * logic that Task 6 owns.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import {
  EMBED_PROGRESS_BATCH,
  ingestDirectory,
  ingestPaths,
  type IngestDeps,
  type IngestPage,
  type IngestProgress,
  type IngestResult,
} from "@/lib/knowledge/ingest";
import type { XlsxExtraction } from "@/lib/knowledge/xlsx-extract";
import type { ConversionOutcome } from "@/lib/knowledge/office-convert";

const ORG_ID = "org-kb-ingest-test";

const PAGE_1_TEXT =
  "This handbook explains the onboarding process for new employees. " +
  "Every new hire receives a laptop, a badge, and access to the internal wiki on their first day.";
const PAGE_2_TEXT =
  "Benefits enrollment must be completed within thirty days of the start date. " +
  "Questions about health insurance or retirement plans should go to the HR team.";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-ingest-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const SHEET_ROWS_TEXT =
  "Supplier: Nordwind GmbH | Material: Petrifilm plates | Lead time: 14 days. " +
  "Supplier: Acme Labor | Material: Agar | Lead time: 5 days.";

/**
 * A spreadsheet extraction with no chunks and every sheet hidden — the shape
 * `extractXlsx` reports for a workbook whose author hid all of it, and the one
 * that must land as `unsearchable` rather than `indexed`.
 */
const EMPTY_XLSX = { chunks: [], sheets: [], hiddenSheets: ["Internal"], hiddenRows: 0 };

/**
 * For the PDF-only tests below that build their deps inline. A spreadsheet
 * never reaches them, and a stub that THROWS says so — a silent empty
 * extraction would let a dispatch bug route a .pdf here and still pass.
 */
const neverCalledXlsx = async (): Promise<XlsxExtraction> => {
  throw new Error("extractXlsx must not be called for a PDF");
};

/** Same reasoning for the converter: no PDF-only test may reach LibreOffice. */
const neverCalledConvert = async (): Promise<ConversionOutcome[]> => {
  throw new Error("convertOffice must not be called for a PDF");
};

function fakeDeps(
  pages = [
    { page: 1, text: PAGE_1_TEXT },
    { page: 2, text: PAGE_2_TEXT },
  ],
  xlsx: XlsxExtraction = {
    chunks: [{ text: SHEET_ROWS_TEXT, sheet: "Suppliers", startRow: 2, endRow: 3 }],
    sheets: ["Suppliers"],
    hiddenSheets: [],
    hiddenRows: 0,
  }
): {
  deps: IngestDeps;
  embed: ReturnType<typeof vi.fn>;
  extractPdf: ReturnType<typeof vi.fn>;
  extractXlsx: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map((_, i) => Array(768).fill(0.001 * (i + 1)))
  );
  const extractPdf = vi.fn(async () => pages);
  const extractXlsx = vi.fn(async () => xlsx);
  return {
    deps: { embed, extractPdf, extractXlsx, convertOffice: neverCalledConvert },
    embed,
    extractPdf,
    extractXlsx,
  };
}

async function chunksFor(documentId: string) {
  return db.select().from(kbChunks).where(eq(kbChunks.documentId, documentId));
}

/**
 * An IngestResult with every counter at zero, overridden by `expected`. Lets a
 * test name only the counters it is about while still asserting via toEqual
 * that every OTHER counter is zero — so a file quietly landing in the wrong
 * bucket fails the test that owns the right one.
 */
function counts(expected: Partial<IngestResult> = {}): IngestResult {
  return {
    indexed: 0,
    skipped: 0,
    removed: 0,
    unsearchable: 0,
    failed: 0,
    archived: 0,
    ...expected,
  };
}

it("indexes a PDF into kb_documents + kb_chunks with real embeddings, then skips a re-run with unchanged content", async () => {
  const pdfPath = join(tmpRoot, "handbook.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes-v1");
  // Non-allowlisted file alongside the PDF: proves the extension allowlist
  // (exclude-globs.ts) actually filters discovery, not just that a lone PDF
  // happens to work.
  writeFileSync(join(tmpRoot, "notes.txt"), "not indexed");

  const { deps, embed, extractPdf } = fakeDeps();

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);

  expect(result).toEqual(counts({ indexed: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(1);
  expect(extractPdf).toHaveBeenCalledWith(pdfPath);

  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(1);
  const [doc] = docs;
  expect(doc.sourcePath).toBe(pdfPath);
  expect(doc.pageCount).toBe(2);
  expect(doc.mtime).not.toBeNull();
  expect(doc.lang).toBe("en");
  expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);

  const chunks = await chunksFor(doc.id);
  expect(chunks.length).toBeGreaterThanOrEqual(1);
  for (const chunk of chunks) {
    expect(chunk.embedding).toHaveLength(768);
    expect(chunk.sourcePath).toBe(pdfPath);
    expect(chunk.orgId).toBe(ORG_ID);
    // The anchor a citation will point at. PDF pages are intrinsic, so `page`
    // is the honest locator kind here — and it is the ONLY producer that
    // exists, so anything else in this column means a chunk was written by
    // something that has not been reviewed against the union (#933).
    expect(chunk.locator).toEqual({ kind: "page", page: expect.any(Number) });
  }
  // Both extracted pages are represented, so a citation can distinguish them.
  // A set, not a list: how many chunks a page yields is the chunker's business.
  const anchoredPages = new Set(
    chunks.map((c) => (c.locator?.kind === "page" ? c.locator.page : null))
  );
  expect([...anchoredPages].sort()).toEqual([1, 2]);
  // notes.txt must never have reached extraction/embedding.
  expect(embed).toHaveBeenCalledTimes(1);

  // ── Second run, no changes on disk ──────────────────────────────────────
  const secondResult = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(secondResult).toEqual(counts({ skipped: 1 }));
  // No re-extraction, no re-embedding: real idempotency, not just a
  // row-count coincidence.
  expect(extractPdf).toHaveBeenCalledTimes(1);
  expect(embed).toHaveBeenCalledTimes(1);

  const docsAfter = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docsAfter).toHaveLength(1);
  expect(docsAfter[0].id).toBe(doc.id);
  expect(docsAfter[0].contentHash).toBe(doc.contentHash);

  const chunksAfter = await chunksFor(doc.id);
  expect(chunksAfter.map((c) => c.id).sort()).toEqual(chunks.map((c) => c.id).sort());
});

it("replaces the document and its chunks when the file's content changes", async () => {
  const pdfPath = join(tmpRoot, "policy.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes-v1");

  const { deps } = fakeDeps();
  await ingestDirectory(ORG_ID, tmpRoot, deps);

  const [originalDoc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const originalChunks = await chunksFor(originalDoc.id);
  expect(originalChunks.length).toBeGreaterThanOrEqual(1);

  writeFileSync(pdfPath, "fake-pdf-bytes-v2-different-content");
  const { deps: updatedDeps } = fakeDeps([{ page: 1, text: "Updated policy text for 2026." }]);

  const result = await ingestDirectory(ORG_ID, tmpRoot, updatedDeps);
  expect(result).toEqual(counts({ indexed: 1 }));

  const docsAfter = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docsAfter).toHaveLength(1);
  expect(docsAfter[0].sourcePath).toBe(pdfPath);
  expect(docsAfter[0].id).not.toBe(originalDoc.id);
  expect(docsAfter[0].contentHash).not.toBe(originalDoc.contentHash);

  // Old chunks are gone (cascade on the old document's delete), replaced by
  // chunks for the new content.
  const oldChunksGone = await db
    .select()
    .from(kbChunks)
    .where(eq(kbChunks.documentId, originalDoc.id));
  expect(oldChunksGone).toHaveLength(0);

  const newChunks = await chunksFor(docsAfter[0].id);
  expect(newChunks.length).toBeGreaterThanOrEqual(1);
});

it("indexes byte-identical files at different paths as separate documents (no unique-hash collision)", async () => {
  // Real corpora carry duplicate content (OLD/ archives, version copies).
  // Documents are keyed by path, not content hash, so two files with
  // identical bytes must both be indexed — a hash-unique constraint here
  // would throw on the second insert.
  const bytes = "identical-pdf-bytes";
  writeFileSync(join(tmpRoot, "current.pdf"), bytes);
  const oldDir = join(tmpRoot, "OLD");
  mkdirSync(oldDir);
  writeFileSync(join(oldDir, "current.pdf"), bytes);

  const { deps } = fakeDeps();
  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);

  // The OLD/ copy is additionally counted as archived (#858) — orthogonal to
  // `indexed`, see the archive-gating tests at the bottom of this file.
  expect(result).toEqual(counts({ indexed: 2, archived: 1 }));
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(2);
  // Both share the same content hash but are distinct rows with distinct paths.
  expect(new Set(docs.map((d) => d.contentHash)).size).toBe(1);
  expect(docs.map((d) => d.sourcePath).sort()).toEqual(
    [join(tmpRoot, "current.pdf"), join(oldDir, "current.pdf")].sort()
  );

  // Idempotent re-run: both skip, no crash, no new rows.
  const secondResult = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(secondResult).toEqual(counts({ skipped: 2, archived: 1 }));
  const docsAfter = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docsAfter).toHaveLength(2);
});

it("removes the document and its chunks when the source file disappears from disk", async () => {
  const pdfPath = join(tmpRoot, "temp.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes");

  const { deps } = fakeDeps();
  await ingestDirectory(ORG_ID, tmpRoot, deps);

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(await chunksFor(doc.id)).not.toHaveLength(0);

  rmSync(pdfPath);

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(result).toEqual(counts({ removed: 1 }));

  const docsAfter = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docsAfter).toHaveLength(0);
  const chunksAfter = await chunksFor(doc.id);
  expect(chunksAfter).toHaveLength(0);
});

it("does not touch documents indexed from a different root directory for the same org", async () => {
  const otherRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-ingest-other-"));
  try {
    const otherPdfPath = join(otherRoot, "other.pdf");
    writeFileSync(otherPdfPath, "other-root-bytes");
    const { deps: otherDeps } = fakeDeps();
    await ingestDirectory(ORG_ID, otherRoot, otherDeps);

    const pdfPath = join(tmpRoot, "mine.pdf");
    writeFileSync(pdfPath, "my-root-bytes");
    const { deps } = fakeDeps();
    const result = await ingestDirectory(ORG_ID, tmpRoot, deps);

    // Ingesting tmpRoot must not report the other root's untouched file as
    // removed, and must leave its document row alone.
    expect(result).toEqual(counts({ indexed: 1 }));
    const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    expect(docs.map((d) => d.sourcePath).sort()).toEqual([otherPdfPath, pdfPath].sort());
  } finally {
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

// Robustness case (migration/pre-existing-data guard spirit): a kb_documents
// row can exist with zero kb_chunks — e.g. a prior ingest crashed after the
// document insert but before chunk writes, or an operator hand-deleted
// kb_chunks rows. The content hash on disk still matches the document row,
// so a naive "hash matches -> skip" would leave this document permanently
// unsearchable while silently reporting success. We chose recovery over
// silent skip: re-ingest detects the zero-chunk document and rebuilds its
// chunks in place (same document id, no duplicate row), rather than crashing
// or reporting indexed=0/skipped=1 with the document still chunkless.
it("recovers a document whose chunks were deleted directly, without crashing or leaving it silently chunkless", async () => {
  const pdfPath = join(tmpRoot, "partial.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes");

  const { deps } = fakeDeps();
  await ingestDirectory(ORG_ID, tmpRoot, deps);

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(await chunksFor(doc.id)).not.toHaveLength(0);

  // Simulate the partial/legacy state directly against the DB.
  await db.delete(kbChunks).where(eq(kbChunks.documentId, doc.id));
  expect(await chunksFor(doc.id)).toHaveLength(0);

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(result.removed).toBe(0);

  const docsAfter = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, ORG_ID), eq(kbDocuments.sourcePath, pdfPath)));
  expect(docsAfter).toHaveLength(1);
  expect(docsAfter[0].id).toBe(doc.id);

  const chunksAfter = await chunksFor(doc.id);
  expect(chunksAfter.length).toBeGreaterThan(0);
});

// Robustness: an agent's allowed_paths grant can point at a single FILE, not
// only a directory (pinchy-files allows either). A naive readdir(root) throws
// ENOTDIR on a file root, which the reindex route would surface as an opaque
// 500. Ingest must instead treat a file root as a one-file corpus.
it("accepts a single-file root path (not just a directory) and indexes that one file", async () => {
  const pdfPath = join(tmpRoot, "solo.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes-solo");

  const { deps, extractPdf } = fakeDeps();
  // Root IS the file, not its parent directory.
  const result = await ingestDirectory(ORG_ID, pdfPath, deps);

  expect(result).toEqual(counts({ indexed: 1 }));
  expect(extractPdf).toHaveBeenCalledWith(pdfPath);

  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(1);
  expect(docs[0].sourcePath).toBe(pdfPath);

  // Idempotent on a file root too: a second run skips, never re-removes.
  const second = await ingestDirectory(ORG_ID, pdfPath, deps);
  expect(second).toEqual(counts({ skipped: 1 }));
});

it("ignores a single-file root whose extension is not on the allowlist", async () => {
  const txtPath = join(tmpRoot, "notes.txt");
  writeFileSync(txtPath, "not a pdf");

  const { deps, extractPdf } = fakeDeps();
  const result = await ingestDirectory(ORG_ID, txtPath, deps);

  expect(result).toEqual(counts());
  expect(extractPdf).not.toHaveBeenCalled();
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(0);
});

it("returns a zero result for a root path that does not exist, without throwing", async () => {
  const result = await ingestDirectory(ORG_ID, join(tmpRoot, "does-not-exist"), fakeDeps().deps);
  expect(result).toEqual(counts());
});

// An image-only scan (~13% of the reference customer corpus, incl. every
// certificate) parses fine and yields pages with no text layer, so chunking
// produces nothing and the document is never retrievable. Counting that as
// `indexed` tells an admin the corpus is complete while a slice of it can
// never answer a question — the count exists to mean "findable", so a
// zero-chunk document gets its own honest bucket instead.
it("reports a text-less scan as unsearchable rather than indexed, on the first run and every run after", async () => {
  const pdfPath = join(tmpRoot, "scan.pdf");
  writeFileSync(pdfPath, "fake-scanned-pdf-bytes");

  // What pdfjs returns for an image-only scan: pages exist, text layer empty.
  const { deps, embed } = fakeDeps([
    { page: 1, text: "" },
    { page: 2, text: "   " },
  ]);

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(result).toEqual(counts({ unsearchable: 1 }));
  // Nothing to embed — the scan must not burn an embedding call.
  expect(embed).not.toHaveBeenCalled();

  // The document row still exists: it IS a known corpus file, and the removal
  // pass must not treat "no chunks" as "gone from disk".
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(1);
  expect(docs[0].sourcePath).toBe(pdfPath);
  expect(await chunksFor(docs[0].id)).toHaveLength(0);

  // Every subsequent run reports the same honest number. The zero-chunk
  // recovery branch re-extracts this file forever (its hash never changes and
  // it never gains chunks), which is exactly why it must not re-report itself
  // as freshly `indexed` each time.
  const second = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(second).toEqual(counts({ unsearchable: 1 }));
  const docsAfter = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docsAfter).toHaveLength(1);
  expect(docsAfter[0].id).toBe(docs[0].id);
});

// A corpus is not a curated fixture: one corrupt or unreadable PDF is normal.
// Without a per-file boundary it aborts the entire reindex, so a single bad
// file costs every other file its update — and under a retrying job runner it
// would fail the same way forever.
it("keeps ingesting the rest of the corpus when one file's extraction throws", async () => {
  writeFileSync(join(tmpRoot, "a-broken.pdf"), "corrupt-bytes");
  writeFileSync(join(tmpRoot, "b-good.pdf"), "good-bytes");

  const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.1)));
  const extractPdf = vi.fn(async (absPath: string) => {
    if (absPath.endsWith("a-broken.pdf")) throw new Error("Invalid PDF structure");
    return [{ page: 1, text: PAGE_1_TEXT }];
  });

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await ingestDirectory(ORG_ID, tmpRoot, {
      embed,
      extractPdf,
      extractXlsx: neverCalledXlsx,
      convertOffice: neverCalledConvert,
    });

    expect(result).toEqual(counts({ indexed: 1, failed: 1 }));

    // `failed: 1` alone is a dead end — the admin-facing counts must not name
    // paths (PII rule), so the server log is the only place that says WHICH
    // file failed and why. One log line per failed file, path and cause.
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(join(tmpRoot, "a-broken.pdf"));
    expect(logged).toContain("Invalid PDF structure");
  } finally {
    consoleError.mockRestore();
  }
  // The good file is indexed regardless of walk order; the broken one leaves
  // no half-written document row behind.
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs.map((d) => d.sourcePath)).toEqual([join(tmpRoot, "b-good.pdf")]);
  expect(await chunksFor(docs[0].id)).not.toHaveLength(0);
});

// The counterpart to the test above, and the reason the per-file boundary is
// scoped to extraction only: Ollama being unreachable is ONE outage, not N
// corrupt files. Swallowing it per file would report "193 failed" for a
// systemic problem, bury the actual cause, and pointlessly parse the whole
// corpus on the way. Embedding and DB errors abort the run and surface.
it("surfaces an embedding outage as a run failure instead of blaming every file", async () => {
  writeFileSync(join(tmpRoot, "a.pdf"), "bytes-a");
  writeFileSync(join(tmpRoot, "b.pdf"), "bytes-b");

  const embed = vi.fn(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  });
  const extractPdf = vi.fn(async () => [{ page: 1, text: PAGE_1_TEXT }]);

  await expect(
    ingestDirectory(ORG_ID, tmpRoot, {
      embed,
      extractPdf,
      extractXlsx: neverCalledXlsx,
      convertOffice: neverCalledConvert,
    })
  ).rejects.toThrow(/ECONNREFUSED/);
  // Bailed on the first file rather than walking the rest of the corpus.
  expect(embed).toHaveBeenCalledTimes(1);
});

// The replace path must not destroy before it can rebuild: a previously
// indexed file that changes into something unparseable is a `failed` UPDATE,
// not a license to drop the last good version. Deleting the old document
// before extraction would leave the corpus silently poorer on every such
// file — the run reports success with failed:1 while content that was
// findable yesterday is gone today.
it("keeps the last indexed version searchable when a file changes into one that fails to parse", async () => {
  const pdfPath = join(tmpRoot, "policy.pdf");
  writeFileSync(pdfPath, "good-bytes-v1");

  const { deps } = fakeDeps([{ page: 1, text: PAGE_1_TEXT }]);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  const [docBefore] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const chunksBefore = await chunksFor(docBefore.id);
  expect(chunksBefore).not.toHaveLength(0);

  // The file changes on disk, but the new version is corrupt.
  writeFileSync(pdfPath, "corrupt-bytes-v2");
  const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.1)));
  const extractPdf = vi.fn(async () => {
    throw new Error("Invalid PDF structure");
  });

  const result = await ingestDirectory(ORG_ID, tmpRoot, {
    embed,
    extractPdf,
    extractXlsx: neverCalledXlsx,
    convertOffice: neverCalledConvert,
  });
  expect(result).toEqual(counts({ failed: 1 }));

  // The last good version is still there, chunks and all: same document row,
  // old content hash, so the next run with a repaired file re-indexes it.
  const docsAfter = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docsAfter).toHaveLength(1);
  expect(docsAfter[0].id).toBe(docBefore.id);
  expect(docsAfter[0].contentHash).toBe(docBefore.contentHash);
  expect(await chunksFor(docBefore.id)).toHaveLength(chunksBefore.length);
});

// ── ingestPaths: many roots, one honest progress total ───────────────────

/** Records every onProgress call so a test can assert the SEQUENCE, not just the final number — a bar that jumps 0 → done is not progress. */
function progressRecorder() {
  const seen: Array<{ processed: number; total: number }> = [];
  const bytes: Array<{ processedBytes: number; totalBytes: number }> = [];
  const counts: IngestResult[] = [];
  return {
    seen,
    bytes,
    counts,
    onProgress: (p: IngestProgress) => {
      seen.push({ processed: p.processed, total: p.total });
      bytes.push({ processedBytes: p.processedBytes, totalBytes: p.totalBytes });
      counts.push({ ...p.counts });
    },
  };
}

function writePdf(dir: string, name: string, bytes = "fake-pdf-bytes") {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

it("publishes the discovery total before any file is processed, then counts up to it", async () => {
  writePdf(tmpRoot, "a.pdf", "a");
  writePdf(tmpRoot, "b.pdf", "b");
  const { deps } = fakeDeps();
  const { seen, onProgress } = progressRecorder();

  const result = await ingestPaths(ORG_ID, [tmpRoot], deps, { onProgress });

  expect(result).toEqual(counts({ indexed: 2 }));
  // The total is known upfront (discovery walked every root before the first
  // extract), so the first report already carries it. A total that grew as the
  // run went would make the bar run backwards.
  expect(seen).toEqual([
    { processed: 0, total: 2 },
    { processed: 1, total: 2 },
    { processed: 2, total: 2 },
  ]);
});

it("counts progress across all roots against one total instead of restarting per root", async () => {
  const hr = join(tmpRoot, "hr");
  const legal = join(tmpRoot, "legal");
  writePdf(hr, "a.pdf", "a");
  writePdf(legal, "b.pdf", "b");
  writePdf(legal, "c.pdf", "c");
  const { deps } = fakeDeps();
  const { seen, onProgress } = progressRecorder();

  const result = await ingestPaths(ORG_ID, [hr, legal], deps, { onProgress });

  expect(result).toEqual(counts({ indexed: 3 }));
  expect(seen).toEqual([
    { processed: 0, total: 3 },
    { processed: 1, total: 3 },
    { processed: 2, total: 3 },
    { processed: 3, total: 3 },
  ]);
});

// An admin can grant both a parent and its child (/data and /data/hr) — the
// permissions UI has no reason to forbid it. Discovery would then find the same
// file under both roots: counted twice in the total, the bar would stop at 3/4,
// and the file would be ingested twice (indexed, then skipped) inflating the
// counts. One file on disk is one unit of work.
it("counts a file reachable from two overlapping roots exactly once", async () => {
  const hr = join(tmpRoot, "hr");
  writePdf(hr, "shared.pdf", "shared");
  const { deps, extractPdf } = fakeDeps();
  const { seen, onProgress } = progressRecorder();

  const result = await ingestPaths(ORG_ID, [tmpRoot, hr], deps, { onProgress });

  expect(result).toEqual(counts({ indexed: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([
    { processed: 0, total: 1 },
    { processed: 1, total: 1 },
  ]);
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(1);
});

// Overlap must not make one root's removal pass delete the other's documents:
// the passes stay per-root, so a document is only removed when it is gone from
// the root it lives under.
it("keeps a shared document when re-ingesting overlapping roots", async () => {
  const hr = join(tmpRoot, "hr");
  writePdf(hr, "shared.pdf", "shared");
  const { deps } = fakeDeps();

  await ingestPaths(ORG_ID, [tmpRoot, hr], deps);
  const second = await ingestPaths(ORG_ID, [tmpRoot, hr], deps);

  expect(second).toEqual(counts({ skipped: 1 }));
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(1);
});

// A granted folder is usually a bind mount. If it is not ready yet — and the
// index worker now starts seconds after boot, so that is a live race — stat
// throws and discovery finds nothing. Treating "I could not look" as "there is
// nothing there" hands the removal pass an empty set, and scoping it to the
// root then selects the ENTIRE corpus under that root for deletion. The run
// reports success, `removed: N`, and the next reindex re-embeds everything.
it("never removes a root's documents when the root itself could not be read", async () => {
  const mount = join(tmpRoot, "mount");
  writePdf(mount, "handbook.pdf");
  const { deps } = fakeDeps();

  await ingestPaths(ORG_ID, [mount], deps);
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(1);

  // The mount goes away (unmounted, or simply not attached yet).
  rmSync(mount, { recursive: true, force: true });

  const result = await ingestPaths(ORG_ID, [mount], deps);

  expect(result).toEqual(counts());
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(1);
});

// The other side of the same coin: a root we CAN read, that is genuinely empty,
// must still drop what is no longer there. Otherwise deleting a document would
// never take it out of the index.
it("removes a root's documents when the root is readable and its files are gone", async () => {
  const dir = join(tmpRoot, "dir");
  writePdf(dir, "handbook.pdf");
  const { deps } = fakeDeps();

  await ingestPaths(ORG_ID, [dir], deps);
  rmSync(join(dir, "handbook.pdf"));

  const result = await ingestPaths(ORG_ID, [dir], deps);

  expect(result).toEqual(counts({ removed: 1 }));
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(0);
});

it("still reports a total of zero for roots with nothing to ingest", async () => {
  const { deps } = fakeDeps();
  const { seen, onProgress } = progressRecorder();

  const result = await ingestPaths(ORG_ID, [join(tmpRoot, "nope")], deps, { onProgress });

  expect(result).toEqual(counts());
  // Still one report: "0 of 0" is a finished run, and a caller that never hears
  // anything cannot tell that apart from a run that never started.
  expect(seen).toEqual([{ processed: 0, total: 0 }]);
});

// The tally travels WITH the progress report, because the return value is
// exactly what a systemic failure destroys. A caller that only reads the return
// learns nothing about a run that died two thirds of the way through.
it("reports the running tally alongside progress, so a caller keeps it when the run throws", async () => {
  writePdf(tmpRoot, "a-good.pdf", "a");
  writePdf(tmpRoot, "b-good.pdf", "b");
  writePdf(tmpRoot, "c-outage.pdf", "c");
  const { deps } = fakeDeps();
  let embedCalls = 0;
  (deps.embed as ReturnType<typeof vi.fn>).mockImplementation(async (texts: string[]) => {
    if (++embedCalls > 2) throw new Error("connect ECONNREFUSED");
    return texts.map(() => Array(768).fill(0.01));
  });
  const recorder = progressRecorder();

  await expect(
    ingestPaths(ORG_ID, [tmpRoot], deps, { onProgress: recorder.onProgress })
  ).rejects.toThrow(/ECONNREFUSED/);

  // The last report before the outage is the honest record: two indexed.
  expect(recorder.counts.at(-1)).toEqual(counts({ indexed: 2 }));
  expect(recorder.seen.at(-1)).toEqual({ processed: 2, total: 3 });
});

it("carries a zeroed tally on the very first report, before anything is counted", async () => {
  writePdf(tmpRoot, "a.pdf", "a");
  const { deps } = fakeDeps();
  const recorder = progressRecorder();

  await ingestPaths(ORG_ID, [tmpRoot], deps, { onProgress: recorder.onProgress });

  expect(recorder.counts[0]).toEqual(counts());
  expect(recorder.counts.at(-1)).toEqual(counts({ indexed: 1 }));
});

// A file the run could not read still moved the run forward — progress measures
// how much of the corpus is behind us, not how much of it succeeded.
it("advances progress past a file that failed to extract", async () => {
  writePdf(tmpRoot, "a-broken.pdf", "broken");
  writePdf(tmpRoot, "b-good.pdf", "good");
  const { deps } = fakeDeps();
  (deps.extractPdf as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
    if (p.endsWith("a-broken.pdf")) throw new Error("Invalid PDF structure");
    return [{ page: 1, text: PAGE_1_TEXT }];
  });
  const { seen, onProgress } = progressRecorder();

  const result = await ingestPaths(ORG_ID, [tmpRoot], deps, { onProgress });

  expect(result).toEqual(counts({ indexed: 1, failed: 1 }));
  expect(seen.at(-1)).toEqual({ processed: 2, total: 2 });
});

// ── byte-weighted progress: the denominator a real ETA needs (#907) ──────

// Documents are not equal units of work — the 2026-07 dry-run had one
// compilation PDF worth 38% of every chunk in the corpus beside hundreds of
// one-chunk product sheets. Bytes on disk are the one work-proportional
// measure discovery knows in FULL before the first extract, which is what lets
// a projection off them be an estimate rather than a guess.
it("reports a byte total known in full upfront, and counts bytes up to it", async () => {
  writePdf(tmpRoot, "big.pdf", "b".repeat(900));
  writePdf(tmpRoot, "small.pdf", "s".repeat(100));
  const { deps } = fakeDeps();
  const { bytes, onProgress } = progressRecorder();

  await ingestPaths(ORG_ID, [tmpRoot], deps, { onProgress });

  expect(bytes[0]).toEqual({ processedBytes: 0, totalBytes: 1000 });
  expect(bytes.at(-1)).toEqual({ processedBytes: 1000, totalBytes: 1000 });
});

it("counts bytes across all roots against one total, and a shared file only once", async () => {
  const hr = join(tmpRoot, "hr");
  writePdf(hr, "shared.pdf", "x".repeat(500));
  const { deps } = fakeDeps();
  const { bytes, onProgress } = progressRecorder();

  await ingestPaths(ORG_ID, [tmpRoot, hr], deps, { onProgress });

  expect(bytes.at(-1)).toEqual({ processedBytes: 500, totalBytes: 500 });
});

// The document worth 38% of the corpus is exactly the one that would otherwise
// freeze both bar and ETA for over an hour. Its chunk count IS known once it is
// split, so its bytes are credited as those chunks are embedded.
it("credits a long document's bytes as its chunks are embedded, rather than freezing the bar", async () => {
  const pages = Array.from({ length: EMBED_PROGRESS_BATCH * 2 + 1 }, (_, i) => ({
    page: i + 1,
    text: `Page ${i + 1} of the compilation.`,
  }));
  writePdf(tmpRoot, "compilation.pdf", "x".repeat(1000));
  const { deps } = fakeDeps(pages);
  const { bytes, onProgress } = progressRecorder();

  await ingestPaths(ORG_ID, [tmpRoot], deps, { onProgress });

  // 65 chunks embed as 32 / 32 / 1, so two reports land INSIDE the document
  // carrying its bytes pro rata. The third batch reports nothing — the per-file
  // report that follows it immediately would say the same thing.
  expect(bytes.map((b) => b.processedBytes)).toEqual([0, 492, 985, 1000]);
  // Monotonic throughout: a bar that runs backwards is worse than a coarse one.
  expect(bytes.map((b) => b.processedBytes)).toEqual(
    [...bytes.map((b) => b.processedBytes)].sort((a, b) => a - b)
  );
});

// A corpus of empty files has no bytes to divide by. The run still reports, and
// the byte total stays an honest zero — the ETA's job is to decline, not to
// invent a rate (see estimateRemainingMs).
it("reports a zero byte total rather than faking one when there is nothing to weigh", async () => {
  writePdf(tmpRoot, "empty.pdf", "");
  const { deps } = fakeDeps();
  const { bytes, seen, onProgress } = progressRecorder();

  await ingestPaths(ORG_ID, [tmpRoot], deps, { onProgress });

  expect(seen.at(-1)).toEqual({ processed: 1, total: 1 });
  expect(bytes.at(-1)).toEqual({ processedBytes: 0, totalBytes: 0 });
});

// --- archive/freshness gating (#858): status assignment + archived counter ---

it("marks a document under an archive folder as archived, fully ingested, and counts it in `archived`", async () => {
  const currentPath = writePdf(tmpRoot, "certificate-2024.pdf", "current");
  const archivedPath = writePdf(join(tmpRoot, "OLD"), "certificate-2013.pdf", "expired");
  const { deps } = fakeDeps();

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);

  // `archived` is ORTHOGONAL to the outcome partition: the archived doc is
  // both `indexed` (chunks written — the "search the archive too" opt-in
  // needs them) and `archived` (hidden from default retrieval).
  expect(result).toEqual(counts({ indexed: 2, archived: 1 }));

  const [currentDoc] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, ORG_ID), eq(kbDocuments.sourcePath, currentPath)));
  const [archivedDoc] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, ORG_ID), eq(kbDocuments.sourcePath, archivedPath)));

  expect(currentDoc.status).toBe("active");
  expect(archivedDoc.status).toBe("archived");
  // Fully ingested despite being archived: chunks exist.
  expect((await chunksFor(archivedDoc.id)).length).toBeGreaterThan(0);
});

it("keeps counting an unchanged archived document as archived on a skip re-run", async () => {
  writePdf(join(tmpRoot, "Archiv"), "alt.pdf", "alt");
  const { deps } = fakeDeps();

  await ingestDirectory(ORG_ID, tmpRoot, deps);
  const rerun = await ingestDirectory(ORG_ID, tmpRoot, deps);

  expect(rerun).toEqual(counts({ skipped: 1, archived: 1 }));
});

it("heals a stored status that disagrees with the archive rule on the next skip re-run", async () => {
  const archivedPath = writePdf(join(tmpRoot, "OLD"), "binder.pdf", "old-binder");
  const { deps } = fakeDeps();

  await ingestDirectory(ORG_ID, tmpRoot, deps);

  // Simulate a pre-backfill row (or a rule change): status stored as active
  // although the path is under OLD/. The next run must heal it even though
  // the content hash is unchanged (the skip path).
  await db
    .update(kbDocuments)
    .set({ status: "active" })
    .where(and(eq(kbDocuments.orgId, ORG_ID), eq(kbDocuments.sourcePath, archivedPath)));

  const rerun = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(rerun).toEqual(counts({ skipped: 1, archived: 1 }));

  const [doc] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, ORG_ID), eq(kbDocuments.sourcePath, archivedPath)));
  expect(doc.status).toBe("archived");
});

it("indexes a spreadsheet with sheet + row-range locators, and never converts it", async () => {
  const xlsxPath = join(tmpRoot, "suppliers.xlsx");
  writeFileSync(xlsxPath, "fake-xlsx-bytes-v1");

  const { deps, extractPdf, extractXlsx } = fakeDeps();

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);

  expect(result).toEqual(counts({ indexed: 1 }));
  expect(extractXlsx).toHaveBeenCalledWith(xlsxPath);
  // The dispatch, asserted from both sides. A spreadsheet reaching the PDF
  // extractor is the failure this whole format split exists to prevent, and it
  // would otherwise show up only as an unreadable citation much later.
  expect(extractPdf).not.toHaveBeenCalled();

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(doc.sourcePath).toBe(xlsxPath);
  // A sheet is not a page. Writing the sheet COUNT here would make the row
  // state something false about the document; the column is nullable for it.
  expect(doc.pageCount).toBeNull();

  const chunks = await chunksFor(doc.id);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].locator).toEqual({
    kind: "sheet",
    sheet: "Suppliers",
    startRow: 2,
    endRow: 3,
  });
  expect(chunks[0].embedding).toHaveLength(768);
  expect(chunks[0].sourcePath).toBe(xlsxPath);
});

it("books a workbook it could read nothing out of as unsearchable, not indexed", async () => {
  // Every sheet hidden by its author: `extractXlsx` reports the hidden sheets
  // and no chunks. "0 chunks" is exactly what an unreadable file gives, so it
  // must land in the same bucket a text-less scan does — visible in the
  // unreadable list rather than counted as a successful index (#935).
  const xlsxPath = join(tmpRoot, "internal.xlsx");
  writeFileSync(xlsxPath, "fake-xlsx-all-hidden");

  const { deps } = fakeDeps(undefined, EMPTY_XLSX);

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(await chunksFor(doc.id)).toHaveLength(0);
});

it("keeps PDFs indexed before spreadsheets existed working, untouched", async () => {
  // AGENTS.md § Test Migrations Against Pre-Existing Data. Every other test
  // here starts from a clean slate where the dispatch is live from the first
  // write, so none of them can see what an UPGRADE produces: rows written by
  // the PDF-only pipeline, read by code that now dispatches on extension.
  //
  // Simulated by ingesting the PDF alone (which is exactly what the old
  // pipeline did), then dropping a spreadsheet beside it and re-running.
  const pdfPath = join(tmpRoot, "handbook.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes-v1");

  const { deps } = fakeDeps();
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  const [before] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const chunksBefore = await chunksFor(before.id);

  writeFileSync(join(tmpRoot, "suppliers.xlsx"), "fake-xlsx-bytes-v1");
  const rerun = await ingestDirectory(ORG_ID, tmpRoot, deps);

  // The PDF is SKIPPED, not re-indexed: the content hash still matches, and a
  // widened allowlist must not invalidate what was already there.
  expect(rerun).toEqual(counts({ skipped: 1, indexed: 1 }));

  const [pdfDoc] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, ORG_ID), eq(kbDocuments.sourcePath, pdfPath)));
  expect(pdfDoc.id).toBe(before.id);
  expect(pdfDoc.pageCount).toBe(2);
  const chunksAfter = await chunksFor(pdfDoc.id);
  expect(chunksAfter.map((c) => c.id).sort()).toEqual(chunksBefore.map((c) => c.id).sort());
  for (const chunk of chunksAfter) {
    expect(chunk.locator).toEqual({ kind: "page", page: expect.any(Number) });
  }
});

// ---------------------------------------------------------------------------
// Page-shaped Office documents (#938)
// ---------------------------------------------------------------------------

/**
 * The Office half of the pipeline: convert with LibreOffice, index the
 * CONVERTED PDF, but keep the original as the document's identity.
 *
 * The converter and the extractor are both fakes here for the same reason the
 * PDF tests fake theirs — what is under test is the dispatch, the anchors and
 * the failure semantics, not LibreOffice. That the real binary carries a Word
 * outline into PDF bookmarks (and leaves comments and speaker notes out) is
 * pinned separately, against the real thing, in
 * `office-convert.libreoffice.test.ts`.
 */
const WORD_PAGES: IngestPage[] = [
  {
    page: 1,
    text: "Quality management\nEvery delivery is checked against the order before storage.",
    headings: [{ charStart: 0, headings: ["Quality management"] }],
  },
  { page: 2, text: "Protective equipment is mandatory in zone B at all times." },
];

const SLIDE_PAGES: IngestPage[] = [
  { page: 1, text: "Pricing for the coming season, including the volume discounts." },
  { page: 2, text: "Delivery windows and the lead times each supplier has committed to." },
];

/**
 * Deps whose converter answers with an artifact path per source, and whose
 * extractor answers per artifact. `convertOffice` records its calls so a test
 * can assert on BATCHES — the property the conversion cost depends on.
 */
function officeDeps(
  outcomes: (absPath: string) => ConversionOutcome,
  pagesFor: (artifactPath: string) => IngestPage[]
) {
  const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.05)));
  const extractPdf = vi.fn(async (absPath: string) => pagesFor(absPath));
  const convertOffice = vi.fn(async (sources: readonly { absPath: string }[]) =>
    sources.map((source) => outcomes(source.absPath))
  );
  return {
    deps: { embed, extractPdf, extractXlsx: neverCalledXlsx, convertOffice } as IngestDeps,
    extractPdf,
    convertOffice,
  };
}

/** A converted outcome whose artifact sits beside the source, as the store's would. */
const convertedTo =
  (artifactPath: string) =>
  (absPath: string): ConversionOutcome => ({
    sourcePath: absPath,
    status: "converted" as const,
    artifactPath,
  });

it("indexes a Word document through its converted PDF, anchored on the heading path", async () => {
  const docPath = join(tmpRoot, "Qualitätshandbuch.doc");
  writeFileSync(docPath, "fake-doc-bytes");

  const { deps, extractPdf } = officeDeps(convertedTo("/artifacts/ab/cd.pdf"), () => WORD_PAGES);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  // The outline is only asked for where it is the anchor.
  expect(extractPdf).toHaveBeenCalledWith("/artifacts/ab/cd.pdf", { outline: true });

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  // Identity stays the ORIGINAL. A citation naming the artifact would point at
  // a file that is not on the reader's share.
  expect(doc.sourcePath).toBe(docPath);
  // Word's pagination belongs to the renderer, so the row says nothing rather
  // than something the reader's Word disagrees with.
  expect(doc.pageCount).toBeNull();

  const chunks = await chunksFor(doc.id);
  expect(chunks).not.toHaveLength(0);
  expect(chunks.every((chunk) => chunk.sourcePath === docPath)).toBe(true);
  for (const chunk of chunks) {
    expect(chunk.locator).toEqual({ kind: "heading", headings: ["Quality management"] });
  }
});

it("gives a Word document without headings no locator at all, rather than a page", async () => {
  // #938 says it plainly: an omitted locator beats one that does not match
  // what the reader sees in Word. A page number would be exactly that.
  writeFileSync(join(tmpRoot, "Notiz.docx"), "fake-docx-bytes");

  const { deps } = officeDeps(convertedTo("/artifacts/no/outline.pdf"), () => [
    { page: 1, text: "A short note with no heading styles anywhere in it." },
  ]);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const chunks = await chunksFor(doc.id);
  expect(chunks).not.toHaveLength(0);
  expect(chunks.every((chunk) => chunk.locator === null)).toBe(true);
});

it("anchors a presentation on its slide number, which the converter maps one to one", async () => {
  const pptPath = join(tmpRoot, "Schulung.ppt");
  writeFileSync(pptPath, "fake-ppt-bytes");

  const { deps, extractPdf } = officeDeps(convertedTo("/artifacts/ee/ff.pdf"), () => SLIDE_PAGES);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  // No outline is asked for: a presentation's bookmarks are slide names, not
  // a heading hierarchy, and slide N is page N without them.
  expect(extractPdf).toHaveBeenCalledWith("/artifacts/ee/ff.pdf", { outline: false });

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(doc.sourcePath).toBe(pptPath);
  // Slides ARE the document's own units, so the count is the document's.
  expect(doc.pageCount).toBe(2);

  const chunks = await chunksFor(doc.id);
  expect(
    chunks
      .map((chunk) => chunk.locator)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  ).toEqual([
    { kind: "slide", slide: 1 },
    { kind: "slide", slide: 2 },
  ]);
});

it("leaves a document whose conversion failed in the index with no chunks", async () => {
  // #936's `failed` is a FINAL verdict about this document. A row with no
  // chunks is how the unreadable list (#935) finds it, with nothing to wire
  // up — so the row must exist, and it must be empty.
  const docPath = join(tmpRoot, "kaputt.doc");
  writeFileSync(docPath, "fake-doc-bytes");

  const { deps, extractPdf } = officeDeps(
    (absPath) => ({ sourcePath: absPath, status: "failed", reason: "no artifact produced" }),
    () => WORD_PAGES
  );

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
  expect(extractPdf).not.toHaveBeenCalled();

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(doc.sourcePath).toBe(docPath);
  expect(await chunksFor(doc.id)).toHaveLength(0);
});

it("does not record a document as unreadable when the converter itself was unavailable", async () => {
  // The distinction #936 exists for: out of memory or a missing binary says
  // nothing about the document. Recording it would brand a perfectly good file
  // as permanently unreadable, and nothing ever retries that.
  writeFileSync(join(tmpRoot, "gut.doc"), "fake-doc-bytes");

  const { deps } = officeDeps(
    (absPath) => ({
      sourcePath: absPath,
      status: "infrastructure",
      reason: "converter was killed — out of memory",
    }),
    () => WORD_PAGES
  );

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ failed: 1 }));
  } finally {
    consoleError.mockRestore();
  }

  // No row at all, so the unreadable list does not claim this document.
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(0);
});

it("keeps the last indexed version when a re-conversion of a changed file fails at the infrastructure level", async () => {
  const docPath = join(tmpRoot, "Angebot.docx");
  writeFileSync(docPath, "fake-docx-v1");

  const good = officeDeps(convertedTo("/artifacts/v1.pdf"), () => WORD_PAGES);
  expect(await ingestDirectory(ORG_ID, tmpRoot, good.deps)).toEqual(counts({ indexed: 1 }));
  const [before] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const chunksBefore = await chunksFor(before.id);

  writeFileSync(docPath, "fake-docx-v2");
  const squeezed = officeDeps(
    (absPath) => ({ sourcePath: absPath, status: "infrastructure", reason: "killed" }),
    () => WORD_PAGES
  );

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, squeezed.deps)).toEqual(counts({ failed: 1 }));
  } finally {
    consoleError.mockRestore();
  }

  const [after] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(after.id).toBe(before.id);
  expect((await chunksFor(after.id)).map((c) => c.id).sort()).toEqual(
    chunksBefore.map((c) => c.id).sort()
  );
});

it("converts in batches, and not at all for a document it can skip", async () => {
  // Process startup dominates conversion, so the ingest must hand the
  // converter a slice of its queue rather than one path at a time. And an
  // unchanged document costs no conversion at all: the skip decision happens
  // before anything is handed over.
  for (let i = 0; i < 3; i++) writeFileSync(join(tmpRoot, `doc-${i}.docx`), `bytes-${i}`);
  writeFileSync(join(tmpRoot, "handbook.pdf"), "fake-pdf-bytes");

  const { deps, convertOffice } = officeDeps(convertedTo("/artifacts/batch.pdf"), (artifact) =>
    artifact === "/artifacts/batch.pdf" ? WORD_PAGES : [{ page: 1, text: PAGE_1_TEXT }]
  );

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 4 }));

  // One call carrying all three Office documents — and the PDF is not among
  // them, so a dispatch bug cannot route it through LibreOffice.
  expect(convertOffice).toHaveBeenCalledTimes(1);
  const converted = convertOffice.mock.calls[0][0].map((source) => source.absPath);
  expect(converted).toHaveLength(3);
  expect(converted.every((path: string) => path.endsWith(".docx"))).toBe(true);

  const rerun = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(rerun).toEqual(counts({ skipped: 4 }));
  expect(convertOffice).toHaveBeenCalledTimes(1);
});

it("batches from the document that asked, carrying the hash the ingest already computed", async () => {
  // Two properties of the same call, because they are the same decision.
  //
  // A batch sliced from the HEAD of the queue drags every Office document
  // before the changed one through the converter — and those are exactly the
  // documents the run is about to skip, so the work is thrown away. Worse, it
  // is not free: `convertOfficeFiles` hashes every source it is handed, a full
  // read each, even for a cache hit.
  //
  // And the hash is the artifact key. The ingest computed it one step earlier
  // for its own idempotency check; `OfficeSource.contentHash` exists so that
  // read is not paid for twice.
  for (let i = 0; i < 3; i++) writeFileSync(join(tmpRoot, `doc-${i}.docx`), `bytes-${i}`);

  const { deps, convertOffice } = officeDeps(convertedTo("/artifacts/batch.pdf"), () => WORD_PAGES);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 3 }));
  expect(convertOffice).toHaveBeenCalledTimes(1);

  // A first run needs every document, so the batch is still the whole queue.
  // Only the document that ASKED carries a hash: the ingest has read exactly
  // that one so far, and `convertOfficeFiles` hashes the rest itself when it
  // gets to them. Claiming otherwise would mean reading them here as well,
  // which is the read this is removing.
  expect(convertOffice.mock.calls[0][0]).toEqual([
    {
      absPath: join(tmpRoot, "doc-0.docx"),
      contentHash: createHash("sha256").update("bytes-0").digest("hex"),
    },
    { absPath: join(tmpRoot, "doc-1.docx") },
    { absPath: join(tmpRoot, "doc-2.docx") },
  ]);

  // Only the LAST document changes, so the two before it are skipped and must
  // never reach the converter again.
  const changed = join(tmpRoot, "doc-2.docx");
  writeFileSync(changed, "bytes-2-v2");
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ skipped: 2, indexed: 1 }));

  expect(convertOffice).toHaveBeenCalledTimes(2);
  expect(convertOffice.mock.calls[1][0]).toEqual([
    { absPath: changed, contentHash: createHash("sha256").update("bytes-2-v2").digest("hex") },
  ]);
});

it("spends one converter attempt per batch when the converter never answers at all", async () => {
  // `convertOfficeFiles` reports an unavailable converter as an `infrastructure`
  // OUTCOME, but it can still reject outright — constructing the artifact store
  // creates its directory, and a volume that is not mounted throws there.
  //
  // A batch consumed by a rejection with nothing recorded is the trap: every
  // other document in it would then ask again and pull a fresh slice of the
  // queue through LibreOffice before answering the same thing. So the batch is
  // answered once, for all of its documents, and none of them gets a row —
  // an unavailable converter says nothing about any document (#936).
  for (let i = 0; i < 3; i++) writeFileSync(join(tmpRoot, `doc-${i}.docx`), `bytes-${i}`);

  const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.05)));
  const extractPdf = vi.fn(async () => {
    throw new Error("extractPdf must not be called when no artifact exists");
  });
  const convertOffice = vi.fn(async () => {
    throw new Error("artifact volume is not mounted");
  });
  const deps = { embed, extractPdf, extractXlsx: neverCalledXlsx, convertOffice } as IngestDeps;

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ failed: 3 }));
  } finally {
    consoleError.mockRestore();
  }

  expect(convertOffice).toHaveBeenCalledTimes(1);
  expect(extractPdf).not.toHaveBeenCalled();
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(0);
});

it("leaves PDFs indexed before Office support was added exactly as they were", async () => {
  // AGENTS.md § "Test Migrations Against Pre-Existing Data": the upgrade state
  // is old rows plus new code, and every test that starts from an empty
  // database is blind to it. Simulated by indexing the PDF alone — which is
  // what the old pipeline did — and then dropping a Word file beside it.
  const pdfPath = join(tmpRoot, "handbook.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes-v1");

  const { deps } = fakeDeps();
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  const [before] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const chunksBefore = await chunksFor(before.id);

  writeFileSync(join(tmpRoot, "Handbuch.doc"), "fake-doc-bytes");
  const mixed = officeDeps(convertedTo("/artifacts/mixed.pdf"), (artifact) =>
    artifact === "/artifacts/mixed.pdf"
      ? WORD_PAGES
      : [
          { page: 1, text: PAGE_1_TEXT },
          { page: 2, text: PAGE_2_TEXT },
        ]
  );

  // The PDF is SKIPPED, not re-indexed: its content hash still matches, and a
  // widened allowlist must not invalidate what was already there.
  expect(await ingestDirectory(ORG_ID, tmpRoot, mixed.deps)).toEqual(
    counts({ skipped: 1, indexed: 1 })
  );

  const [pdfDoc] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, ORG_ID), eq(kbDocuments.sourcePath, pdfPath)));
  expect(pdfDoc.id).toBe(before.id);
  expect(pdfDoc.pageCount).toBe(2);
  const chunksAfter = await chunksFor(pdfDoc.id);
  expect(chunksAfter.map((c) => c.id).sort()).toEqual(chunksBefore.map((c) => c.id).sort());
  for (const chunk of chunksAfter) {
    expect(chunk.locator).toEqual({ kind: "page", page: expect.any(Number) });
  }
});

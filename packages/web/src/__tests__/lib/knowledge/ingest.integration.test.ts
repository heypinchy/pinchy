/**
 * Real-DB integration tests for ingestDirectory() (discover -> extract ->
 * chunk -> embed -> upsert). Uses a real PostgreSQL test database
 * (provisioned by global-setup.ts, truncated between tests by setup.ts) plus
 * real filesystem I/O against a per-test temp directory. The embedder and
 * PDF extractor are dependency-injected fakes (deterministic 1024-dim
 * vectors, canned page text) so the suite stays hermetic — no Ollama, no
 * real PDF parsing — and exercises the orchestration + idempotency/staleness
 * logic that Task 6 owns.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import {
  ingestDirectory,
  ingestPaths,
  type IngestDeps,
  type IngestProgress,
  type IngestResult,
} from "@/lib/knowledge/ingest";

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

function fakeDeps(
  pages = [
    { page: 1, text: PAGE_1_TEXT },
    { page: 2, text: PAGE_2_TEXT },
  ]
): { deps: IngestDeps; embed: ReturnType<typeof vi.fn>; extractPdf: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map((_, i) => Array(1024).fill(0.001 * (i + 1)))
  );
  const extractPdf = vi.fn(async () => pages);
  return { deps: { embed, extractPdf }, embed, extractPdf };
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
  return { indexed: 0, skipped: 0, removed: 0, unsearchable: 0, failed: 0, ...expected };
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
    expect(chunk.embedding).toHaveLength(1024);
    expect(chunk.sourcePath).toBe(pdfPath);
    expect(chunk.orgId).toBe(ORG_ID);
  }
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

  expect(result).toEqual(counts({ indexed: 2 }));
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(2);
  // Both share the same content hash but are distinct rows with distinct paths.
  expect(new Set(docs.map((d) => d.contentHash)).size).toBe(1);
  expect(docs.map((d) => d.sourcePath).sort()).toEqual(
    [join(tmpRoot, "current.pdf"), join(oldDir, "current.pdf")].sort()
  );

  // Idempotent re-run: both skip, no crash, no new rows.
  const secondResult = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(secondResult).toEqual(counts({ skipped: 2 }));
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

  const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(1024).fill(0.1)));
  const extractPdf = vi.fn(async (absPath: string) => {
    if (absPath.endsWith("a-broken.pdf")) throw new Error("Invalid PDF structure");
    return [{ page: 1, text: PAGE_1_TEXT }];
  });

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await ingestDirectory(ORG_ID, tmpRoot, { embed, extractPdf });

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

  await expect(ingestDirectory(ORG_ID, tmpRoot, { embed, extractPdf })).rejects.toThrow(
    /ECONNREFUSED/
  );
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
  const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(1024).fill(0.1)));
  const extractPdf = vi.fn(async () => {
    throw new Error("Invalid PDF structure");
  });

  const result = await ingestDirectory(ORG_ID, tmpRoot, { embed, extractPdf });
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
  const counts: IngestResult[] = [];
  return {
    seen,
    counts,
    onProgress: (p: IngestProgress) => {
      seen.push({ processed: p.processed, total: p.total });
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
    return texts.map(() => Array(1024).fill(0.01));
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

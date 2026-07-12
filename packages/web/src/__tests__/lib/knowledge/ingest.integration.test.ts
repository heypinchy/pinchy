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
import { ingestDirectory, type IngestDeps } from "@/lib/knowledge/ingest";

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

it("indexes a PDF into kb_documents + kb_chunks with real embeddings, then skips a re-run with unchanged content", async () => {
  const pdfPath = join(tmpRoot, "handbook.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes-v1");
  // Non-allowlisted file alongside the PDF: proves the extension allowlist
  // (exclude-globs.ts) actually filters discovery, not just that a lone PDF
  // happens to work.
  writeFileSync(join(tmpRoot, "notes.txt"), "not indexed");

  const { deps, embed, extractPdf } = fakeDeps();

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);

  expect(result).toEqual({ indexed: 1, skipped: 0, removed: 0 });
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
  expect(secondResult).toEqual({ indexed: 0, skipped: 1, removed: 0 });
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
  expect(result).toEqual({ indexed: 1, skipped: 0, removed: 0 });

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

  expect(result).toEqual({ indexed: 2, skipped: 0, removed: 0 });
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(2);
  // Both share the same content hash but are distinct rows with distinct paths.
  expect(new Set(docs.map((d) => d.contentHash)).size).toBe(1);
  expect(docs.map((d) => d.sourcePath).sort()).toEqual(
    [join(tmpRoot, "current.pdf"), join(oldDir, "current.pdf")].sort()
  );

  // Idempotent re-run: both skip, no crash, no new rows.
  const secondResult = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(secondResult).toEqual({ indexed: 0, skipped: 2, removed: 0 });
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
  expect(result).toEqual({ indexed: 0, skipped: 0, removed: 1 });

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
    expect(result).toEqual({ indexed: 1, skipped: 0, removed: 0 });
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

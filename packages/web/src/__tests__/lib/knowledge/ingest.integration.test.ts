/**
 * Real-DB integration tests for ingestDirectory() (discover -> extract ->
 * chunk -> embed -> upsert). Uses a real PostgreSQL test database
 * (provisioned by global-setup.ts, emptied between tests by the integration
 * reset) plus
 * real filesystem I/O against a per-test temp directory. The embedder and
 * PDF extractor are dependency-injected fakes (deterministic 768-dim
 * vectors, canned page text) so the suite stays hermetic — no Ollama, no
 * real PDF parsing — and exercises the orchestration + idempotency/staleness
 * logic that Task 6 owns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every path this process reads WHOLE (`readFile`). A pass-through: nothing
 * reads differently, the record only says who read what — see the Office
 * memory test below.
 */
const wholeFileReads = vi.hoisted(() => [] as string[]);

/** `fn`, recording the path it is called with. */
function recorded<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    wholeFileReads.push(String(args[0]));
    return fn(...args);
  };
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = { ...actual, readFile: recorded(actual.readFile) };
  return { ...wrapped, default: wrapped };
});

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { makeKbSourceRoot } from "@/test-helpers/kb-source-root";
import { format } from "node:util";
import { and, count, eq } from "drizzle-orm";
import ExcelJS from "exceljs";

/**
 * A pass-through, with one seam: `afterHash` runs once the ingest has hashed a
 * source and before it copies it — the window a save on the share can land in.
 */
const verifiedSourceHooks = vi.hoisted(() => ({
  afterHash: undefined as (() => void) | undefined,
}));

vi.mock("@/lib/knowledge/verified-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/knowledge/verified-source")>();
  return {
    ...actual,
    hashVerifiedSource: async (realPath: string) => {
      const hashed = await actual.hashVerifiedSource(realPath);
      verifiedSourceHooks.afterHash?.();
      return hashed;
    },
  };
});

/**
 * A pass-through, with one seam: `rows` shrinks the batch a kb_chunks INSERT
 * is cut into, so a test can span several batches with a handful of chunks.
 */
const insertBatchOverride = vi.hoisted(() => ({ rows: undefined as number | undefined }));

vi.mock("@/db/insert-batches", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/insert-batches")>();
  return {
    ...actual,
    rowsPerInsert: (table: Parameters<typeof actual.rowsPerInsert>[0]) =>
      insertBatchOverride.rows ?? actual.rowsPerInsert(table),
  };
});

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import { EmbedderUnavailableError } from "@/lib/knowledge/embeddings";
import {
  EMBED_PROGRESS_BATCH,
  EXTRACTION_VERSION,
  MAX_INCOMPLETE_READS,
  ingestDirectory,
  ingestPaths,
  type IngestDeps,
  type IngestPage,
  type IngestProgress,
  type IngestResult,
} from "@/lib/knowledge/ingest";
import { OfficeFileRejectedError, StagedCopyWriteError } from "@/lib/knowledge/office-formats";
import { extractXlsx as realExtractXlsx, type XlsxExtraction } from "@/lib/knowledge/xlsx-extract";
import {
  convertOfficeFiles,
  type ConversionOutcome,
  type ConvertOptions,
  type OfficeSource,
  type PrepareSource,
  type RunConverter,
} from "@/lib/knowledge/office-convert";
import {
  OFFICE_ARTIFACT_FORMAT_VERSION,
  OfficeArtifactStore,
} from "@/lib/knowledge/office-artifacts";
import { stageOfficeSourceIsolated } from "@/lib/knowledge/xlsx-isolated";
import { listUnsearchableDocuments } from "@/lib/knowledge/unsearchable";
import { listUnsupportedFiles, type UnsupportedFile } from "@/lib/knowledge/unsupported-files";

const ORG_ID = "org-kb-ingest-test";

const PAGE_1_TEXT =
  "This handbook explains the onboarding process for new employees. " +
  "Every new hire receives a laptop, a badge, and access to the internal wiki on their first day.";
const PAGE_2_TEXT =
  "Benefits enrollment must be completed within thirty days of the start date. " +
  "Questions about health insurance or retirement plans should go to the HR team.";

let tmpRoot: string;
/** Where the run stages its private copies: the artifact volume's `staging/` in production. */
let stagingDir: string;

beforeEach(() => {
  tmpRoot = makeKbSourceRoot("pinchy-kb-ingest-test-");
  stagingDir = mkdtempSync(join(tmpdir(), "pinchy-kb-ingest-staging-"));
});

afterEach(() => {
  insertBatchOverride.rows = undefined;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
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
  pages: IngestPage[] = [
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
  handed: Map<string, string>;
} {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map((_, i) => Array(768).fill(0.001 * (i + 1)))
  );
  // What each reader found at the path it was handed, read while it still
  // exists: the ingest hands out a private copy and removes it afterwards.
  const handed = new Map<string, string>();
  const record = (path: string) => handed.set(path, readFileSync(path, "utf8"));
  const extractPdf = vi.fn(async (path: string) => (record(path), pages));
  const extractXlsx = vi.fn(async (path: string) => (record(path), xlsx));
  return {
    deps: {
      embed,
      extractPdf,
      extractXlsx,
      convertOffice: neverCalledConvert,
      ocrModel: null,
      stagingDir,
    },
    embed,
    extractPdf,
    extractXlsx,
    handed,
  };
}

/**
 * Asserts a reader was handed a private copy of `sourcePath` holding `bytes` —
 * never the path on the share, which a swap could have pointed elsewhere by
 * the time the reader opened it (verified-source.ts).
 */
function expectPrivateCopy(
  reader: ReturnType<typeof vi.fn>,
  handed: Map<string, string>,
  sourcePath: string,
  bytes: string
) {
  expect(reader).toHaveBeenCalledTimes(1);
  const [path] = reader.mock.calls[0] as [string];
  expect(dirname(path)).not.toBe(dirname(sourcePath));
  // Staged where the run was told to — the artifact volume in production,
  // which the worker clears at start — never in os.tmpdir(), where a copy a
  // killed run left behind would outlive every restart.
  expect(dirname(dirname(path))).toBe(stagingDir);
  // Under the source's own name, so extension dispatch and log lines read right.
  expect(basename(path)).toBe(basename(sourcePath));
  expect(handed.get(path)).toBe(bytes);
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
    unsupported: 0,
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

  const { deps, embed, extractPdf, handed } = fakeDeps();

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);

  expect(result).toEqual(counts({ indexed: 1, unsupported: 1 }));
  expectPrivateCopy(extractPdf, handed, pdfPath, "fake-pdf-bytes-v1");

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
  expect(secondResult).toEqual(counts({ skipped: 1, unsupported: 1 }));
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
  const otherRoot = makeKbSourceRoot("pinchy-kb-ingest-other-");
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

it("reads every current file before any archived one, folder by folder, across roots (#1385)", async () => {
  // A first index of a large share runs for days and people search it while it
  // runs: what retrieval shows by default must be complete first, and whole
  // folders must finish one after another for the per-folder status (#1386).
  const otherRoot = makeKbSourceRoot("pinchy-kb-ingest-order-");
  try {
    const files: Array<[string, string]> = [
      [tmpRoot, "OLD/old-1.pdf"],
      [tmpRoot, "Supplier B/b-1.pdf"],
      [tmpRoot, "Supplier A/a-2.pdf"],
      [tmpRoot, "Supplier A/a-1.pdf"],
      [otherRoot, "Archiv/archiv-1.pdf"],
      [otherRoot, "Certificates/cert-1.pdf"],
    ];
    for (const [root, rel] of files) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), `bytes of ${rel}`);
    }
    const { deps, extractPdf } = fakeDeps();

    await ingestPaths(ORG_ID, [tmpRoot, otherRoot], deps);

    // Both roots sit in the same temp dir, and `pinchy-kb-ingest-order-…`
    // sorts before `pinchy-kb-ingest-test-…`, so the whole order is fixed.
    expect(extractPdf.mock.calls.map(([path]) => basename(path as string))).toEqual([
      "cert-1.pdf",
      "a-1.pdf",
      "a-2.pdf",
      "b-1.pdf",
      "archiv-1.pdf",
      "old-1.pdf",
    ]);
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

it("stores the hash of the bytes it re-read when a chunkless document is saved between its hash and its copy", async () => {
  // The rebuild above reads the file again in place, under the row's stored
  // hash. But the hash that let it in was taken before the copy, and a save in
  // between hands the reader NEW bytes: the row used to keep the old hash
  // beside the new text. Reverting the file then matched that old hash, and
  // every later run skipped the document with the text of a version no longer
  // on disk.
  const pdfPath = join(tmpRoot, "saved-mid-rebuild.pdf");
  writeFileSync(pdfPath, "PDF-v1");
  const hashOf = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const deps: IngestDeps = {
    embed: async (texts) => texts.map(() => Array(768).fill(0.02)),
    extractPdf: async (copy) => [
      { page: 1, text: `Version on disk: ${readFileSync(copy, "utf8")}. ${PAGE_1_TEXT}` },
    ],
    extractXlsx: neverCalledXlsx,
    convertOffice: neverCalledConvert,
    ocrModel: null,
    stagingDir,
  };
  const rowFor = async () =>
    (await db.select().from(kbDocuments).where(eq(kbDocuments.sourcePath, pdfPath)))[0];
  const textOf = async (id: string) =>
    (await chunksFor(id)).map((chunk) => chunk.chunkText).join("\n");

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  await db.delete(kbChunks).where(eq(kbChunks.documentId, (await rowFor()).id));

  verifiedSourceHooks.afterHash = () => {
    verifiedSourceHooks.afterHash = undefined;
    writeFileSync(pdfPath, "PDF-v2");
  };
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  } finally {
    verifiedSourceHooks.afterHash = undefined;
  }
  const rebuilt = await rowFor();
  expect(await textOf(rebuilt.id)).toContain("PDF-v2");
  expect(rebuilt.contentHash).toBe(hashOf("PDF-v2"));

  // Reverted: a change like any other, read again — never skipped as unchanged.
  writeFileSync(pdfPath, "PDF-v1");
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  const reverted = await rowFor();
  expect(reverted.contentHash).toBe(hashOf("PDF-v1"));
  const text = await textOf(reverted.id);
  expect(text).toContain("PDF-v1");
  expect(text).not.toContain("PDF-v2");
});

// Robustness: an agent's allowed_paths grant can point at a single FILE, not
// only a directory (pinchy-files allows either). A naive readdir(root) throws
// ENOTDIR on a file root, which the reindex route would surface as an opaque
// 500. Ingest must instead treat a file root as a one-file corpus.
it("accepts a single-file root path (not just a directory) and indexes that one file", async () => {
  const pdfPath = join(tmpRoot, "solo.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes-solo");

  const { deps, extractPdf, handed } = fakeDeps();
  // Root IS the file, not its parent directory.
  const result = await ingestDirectory(ORG_ID, pdfPath, deps);

  expect(result).toEqual(counts({ indexed: 1 }));
  expectPrivateCopy(extractPdf, handed, pdfPath, "fake-pdf-bytes-solo");

  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(1);
  expect(docs[0].sourcePath).toBe(pdfPath);

  // Idempotent on a file root too: a second run skips, never re-removes.
  const second = await ingestDirectory(ORG_ID, pdfPath, deps);
  expect(second).toEqual(counts({ skipped: 1 }));
});

it("does not ingest a single-file root whose extension is not on the allowlist, and counts it", async () => {
  const txtPath = join(tmpRoot, "notes.txt");
  writeFileSync(txtPath, "not a pdf");

  const { deps, extractPdf } = fakeDeps();
  const result = await ingestDirectory(ORG_ID, txtPath, deps);

  expect(result).toEqual(counts({ unsupported: 1 }));
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
it("reports a text-less scan as unsearchable rather than indexed, and leaves it alone while nothing changed", async () => {
  const pdfPath = join(tmpRoot, "scan.pdf");
  writeFileSync(pdfPath, "fake-scanned-pdf-bytes");

  // What pdfjs returns for an image-only scan: pages exist, text layer empty.
  const { deps, embed, extractPdf } = fakeDeps([
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

  // A run with the same extractor would read the same nothing, so the next
  // one skips it like any unchanged file instead of parsing it again — every
  // night, under the nightly reindex. It is still on the unreadable list,
  // which reads the chunks, not the run's counts.
  const second = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(second).toEqual(counts({ skipped: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(1);
  const docsAfter = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docsAfter).toHaveLength(1);
  expect(docsAfter[0].id).toBe(docs[0].id);
  const listed = await listUnsearchableDocuments(ORG_ID, [tmpRoot]);
  expect(listed.documents.map((doc) => doc.sourcePath)).toEqual([pdfPath]);
});

// ---------------------------------------------------------------------------
// An unchanged document that read as empty
// ---------------------------------------------------------------------------
//
// The zero-chunk recovery branch used to re-extract such a document on every
// run, because a crash leftover and a blank scan both look like "a row with no
// chunks". Under the nightly reindex that meant every blank scan was rendered
// and sent to the vision model again each night. The row now records which
// extractor setup read it as empty (`emptyExtractionBy`), and the branch reads
// it again only when the answer could differ.

const VISION_MODEL = "anthropic/claude-haiku-5-5";
const BLANK_SCAN: IngestPage[] = [{ page: 1, text: "" }];
const FAILED_SCAN: IngestPage[] = [{ page: 1, text: "", ocrFailed: true }];

/** The `emptyExtractionBy` value the current extractor writes for `setup`. */
function marker(setup: string) {
  return `${EXTRACTION_VERSION}|${setup}`;
}

async function onlyDocument() {
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs).toHaveLength(1);
  return docs[0];
}

it("does not send an unchanged blank scan to the vision model again", async () => {
  writeFileSync(join(tmpRoot, "blank.pdf"), "fake-blank-scan");
  const { deps, extractPdf } = fakeDeps(BLANK_SCAN);
  const withOcr = { ...deps, ocrModel: VISION_MODEL };

  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ unsearchable: 1 }));
  expect((await onlyDocument()).emptyExtractionBy).toBe(marker(`ocr:${VISION_MODEL}`));

  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ skipped: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(1);
});

it("reads a blank scan again once OCR becomes available, and indexes what it finds", async () => {
  // The guarantee the docs give an operator who turns OCR on: reindex, and
  // the scans that were unsearchable without it are read.
  writeFileSync(join(tmpRoot, "certificate.pdf"), "fake-certificate-scan");
  const { deps, extractPdf } = fakeDeps(BLANK_SCAN);

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
  const before = await onlyDocument();
  expect(before.emptyExtractionBy).toBe(marker("no-ocr"));

  extractPdf.mockResolvedValue([{ page: 1, text: PAGE_1_TEXT }]);
  const rerun = await ingestDirectory(ORG_ID, tmpRoot, { ...deps, ocrModel: VISION_MODEL });

  expect(rerun).toEqual(counts({ indexed: 1 }));
  const after = await onlyDocument();
  expect(after.id).toBe(before.id);
  expect(after.emptyExtractionBy).toBeNull();
  expect(await chunksFor(after.id)).not.toHaveLength(0);
});

it("reads a blank scan again when a different vision model is configured", async () => {
  writeFileSync(join(tmpRoot, "blank.pdf"), "fake-blank-scan");
  const { deps, extractPdf } = fakeDeps(BLANK_SCAN);

  await ingestDirectory(ORG_ID, tmpRoot, { ...deps, ocrModel: VISION_MODEL });
  const rerun = await ingestDirectory(ORG_ID, tmpRoot, {
    ...deps,
    ocrModel: "openai/gpt-5.5-mini",
  });

  expect(rerun).toEqual(counts({ unsearchable: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(2);
  expect((await onlyDocument()).emptyExtractionBy).toBe(marker("ocr:openai/gpt-5.5-mini"));
});

it("does not read a blank scan again when OCR was turned off since", async () => {
  // Without a vision model the text layer is all there is, and a vision model
  // already found nothing on top of it.
  writeFileSync(join(tmpRoot, "blank.pdf"), "fake-blank-scan");
  const { deps, extractPdf } = fakeDeps(BLANK_SCAN);

  await ingestDirectory(ORG_ID, tmpRoot, { ...deps, ocrModel: VISION_MODEL });
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ skipped: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(1);
});

it("tries a scan again on every run while its vision call keeps failing, and indexes it once one answers", async () => {
  // How a provider outage heals by itself: a failed call is not an answer, so
  // nothing is recorded that would let the next run skip the document.
  writeFileSync(join(tmpRoot, "certificate.pdf"), "fake-certificate-scan");
  const { deps, extractPdf } = fakeDeps([{ page: 1, text: "", ocrFailed: true }]);
  const withOcr = { ...deps, ocrModel: VISION_MODEL };

  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ unsearchable: 1 }));
  expect((await onlyDocument()).emptyExtractionBy).toBeNull();
  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ unsearchable: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(2);

  extractPdf.mockResolvedValue([{ page: 1, text: PAGE_1_TEXT }]);
  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ indexed: 1 }));
});

it("still recovers a row a crash left without chunks", async () => {
  // The case the zero-chunk branch was written for: the document row was
  // inserted, the run died before its chunks were written. Such a row never
  // got an extraction on record, so it must not be mistaken for an empty one.
  const pdfPath = join(tmpRoot, "handbook.pdf");
  writeFileSync(pdfPath, "fake-pdf-bytes-crash");
  const contentHash = createHash("sha256").update("fake-pdf-bytes-crash").digest("hex");
  const [leftover] = await db
    .insert(kbDocuments)
    .values({ orgId: ORG_ID, contentHash, sourcePath: pdfPath })
    .returning();

  const { deps } = fakeDeps();
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  expect((await onlyDocument()).id).toBe(leftover.id);
  expect(await chunksFor(leftover.id)).not.toHaveLength(0);
});

it("reads an empty document indexed before the marker existed once, then leaves it alone", async () => {
  // AGENTS.md § Test Migrations Against Pre-Existing Data. A row the previous
  // pipeline wrote for a blank scan has zero chunks and, after the migration,
  // no `emptyExtractionBy` — the same shape as a crash leftover. It is read
  // once more (the new code cannot know what found it empty), and from then
  // on it is skipped like a row written today.
  const pdfPath = join(tmpRoot, "legacy-scan.pdf");
  writeFileSync(pdfPath, "fake-legacy-scan");
  const contentHash = createHash("sha256").update("fake-legacy-scan").digest("hex");
  await db.insert(kbDocuments).values({ orgId: ORG_ID, contentHash, sourcePath: pdfPath });

  const { deps, extractPdf } = fakeDeps(BLANK_SCAN);
  const withOcr = { ...deps, ocrModel: VISION_MODEL };

  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ unsearchable: 1 }));
  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ skipped: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(1);
});

it("records nothing on a document that has text, so losing its chunks is still recovered", async () => {
  // Only an EMPTY extraction is recorded. A row that had chunks and lost them
  // (an operator deleted kb_chunks rows) must keep coming back, which the
  // recovery test above pins; this pins why it can.
  writeFileSync(join(tmpRoot, "handbook.pdf"), "fake-pdf-bytes");
  await ingestDirectory(ORG_ID, tmpRoot, fakeDeps().deps);

  expect((await onlyDocument()).emptyExtractionBy).toBeNull();
});

function failedConversion(sources: readonly { absPath: string }[]): ConversionOutcome[] {
  return sources.map((source) => ({
    sourcePath: source.absPath,
    status: "failed",
    reason: "no artifact produced",
  }));
}

it("converts an Office document again after a failed conversion, so a passing hiccup heals", async () => {
  // `failed` also covers causes that are not about the document: a source
  // that was briefly unreadable on a network share, or LibreOffice exiting
  // without writing a PDF. Recording such a verdict would freeze the document
  // as unsearchable until somebody edits it.
  writeFileSync(join(tmpRoot, "angebot.docx"), "fake-docx-bytes");
  let converts = false;
  const { deps } = officeDeps(
    (absPath) =>
      converts
        ? convertedTo("/artifacts/an/gebot.pdf")(absPath)
        : failedConversion([{ absPath }])[0],
    () => [{ page: 1, text: PAGE_1_TEXT }]
  );

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
  expect((await onlyDocument()).emptyExtractionBy).toBeNull();

  converts = true;
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
});

it("stops converting an Office document again once it has failed on every one of its retries", async () => {
  writeFileSync(join(tmpRoot, "kaputt.doc"), "fake-doc-bytes");
  const convertOffice = vi.fn(async (sources: readonly { absPath: string }[]) =>
    failedConversion(sources)
  );
  const deps: IngestDeps = { ...fakeDeps().deps, convertOffice };

  for (let run = 1; run <= MAX_INCOMPLETE_READS; run++) {
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
  }
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ skipped: 1 }));
  expect(convertOffice).toHaveBeenCalledTimes(MAX_INCOMPLETE_READS);
  // OCR cannot change what a converter could not convert.
  expect(await ingestDirectory(ORG_ID, tmpRoot, { ...deps, ocrModel: VISION_MODEL })).toEqual(
    counts({ skipped: 1 })
  );
  expect(convertOffice).toHaveBeenCalledTimes(MAX_INCOMPLETE_READS);
});

it("stops sending a scan whose vision call fails on every run once its retries are spent", async () => {
  // A page the provider rejects every time (an image over its size limit, a
  // render pdfjs cannot do) is not an outage that heals. Without a bound,
  // every other page of the document would be sent again every night.
  writeFileSync(join(tmpRoot, "oversized.pdf"), "fake-oversized-scan");
  const { deps, extractPdf } = fakeDeps(FAILED_SCAN);
  const withOcr = { ...deps, ocrModel: VISION_MODEL };

  for (let run = 1; run <= MAX_INCOMPLETE_READS; run++) {
    expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ unsearchable: 1 }));
  }
  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ skipped: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(MAX_INCOMPLETE_READS);

  // A different model is a different reader, and gets its own try.
  await ingestDirectory(ORG_ID, tmpRoot, { ...deps, ocrModel: "openai/gpt-5.5-mini" });
  expect(extractPdf).toHaveBeenCalledTimes(MAX_INCOMPLETE_READS + 1);
});

it("reads the failed pages of a partly indexed scan again, and keeps the document's id", async () => {
  // A typed cover sheet gives the document text of its own, so it has chunks
  // even when every vision call behind it failed. Those pages must come back
  // like a fully failed scan does, or an outage leaves them out for good.
  writeFileSync(join(tmpRoot, "report.pdf"), "fake-report-scan");
  const { deps, extractPdf } = fakeDeps([
    { page: 1, text: PAGE_1_TEXT },
    { page: 2, text: "", ocrFailed: true },
  ]);
  const withOcr = { ...deps, ocrModel: VISION_MODEL };

  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ indexed: 1 }));
  const before = await onlyDocument();

  extractPdf.mockResolvedValue([
    { page: 1, text: PAGE_1_TEXT },
    { page: 2, text: PAGE_2_TEXT },
  ]);
  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ indexed: 1 }));

  const after = await onlyDocument();
  expect(after.id).toBe(before.id);
  const texts = (await chunksFor(after.id)).map((chunk) => chunk.chunkText).join("\n");
  expect(texts).toContain("Benefits enrollment");
  expect(texts.match(/This handbook explains/g)).toHaveLength(1);

  // Complete now, so the next run leaves it alone.
  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ skipped: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(2);
});

it("does not trade a partly indexed scan's text for less on a retry that fails worse", async () => {
  // Page 1 was read by the vision model the first time; on the retries the
  // provider is down altogether. What the first read found stays searchable.
  writeFileSync(join(tmpRoot, "report.pdf"), "fake-report-scan");
  const { deps, extractPdf } = fakeDeps([
    { page: 1, text: PAGE_1_TEXT },
    { page: 2, text: "", ocrFailed: true },
  ]);
  const withOcr = { ...deps, ocrModel: VISION_MODEL };
  await ingestDirectory(ORG_ID, tmpRoot, withOcr);
  const doc = await onlyDocument();
  const stored = await chunksFor(doc.id);
  expect(stored).not.toHaveLength(0);

  extractPdf.mockResolvedValue([
    { page: 1, text: "", ocrFailed: true },
    { page: 2, text: "", ocrFailed: true },
  ]);
  for (let run = 2; run <= MAX_INCOMPLETE_READS; run++) {
    await ingestDirectory(ORG_ID, tmpRoot, withOcr);
  }

  expect(await chunksFor(doc.id)).toEqual(stored);
  // Out of retries, but not empty: it has the text the first read found.
  expect((await onlyDocument()).emptyExtractionBy).toBeNull();
});

it("keeps a partly indexed scan's chunks when the embedder goes down during its retry", async () => {
  writeFileSync(join(tmpRoot, "report.pdf"), "fake-report-scan");
  const { deps, extractPdf, embed } = fakeDeps([
    { page: 1, text: PAGE_1_TEXT },
    { page: 2, text: "", ocrFailed: true },
  ]);
  const withOcr = { ...deps, ocrModel: VISION_MODEL };
  await ingestDirectory(ORG_ID, tmpRoot, withOcr);
  const doc = await onlyDocument();
  const stored = await chunksFor(doc.id);

  extractPdf.mockResolvedValue([
    { page: 1, text: PAGE_1_TEXT },
    { page: 2, text: PAGE_2_TEXT },
  ]);
  embed.mockRejectedValueOnce(new EmbedderUnavailableError("connect ECONNREFUSED"));
  await expect(ingestDirectory(ORG_ID, tmpRoot, withOcr)).rejects.toThrow(/ECONNREFUSED/);

  expect(await chunksFor(doc.id)).toEqual(stored);
  // And the retry is still owed: nothing recorded the read as done.
  expect(await ingestDirectory(ORG_ID, tmpRoot, withOcr)).toEqual(counts({ indexed: 1 }));
});

it("changes a scan's record and its chunks together, so a re-read that dies is still owed", async () => {
  // The record and the chunks are written in one transaction. A model that
  // finds text on a scan the previous one read as empty must not leave a
  // record behind that claims its read happened when its chunks never landed
  // — nor chunks under a record that still says "empty".
  writeFileSync(join(tmpRoot, "certificate.pdf"), "fake-certificate-scan");
  const { deps, extractPdf, embed } = fakeDeps(BLANK_SCAN);
  await ingestDirectory(ORG_ID, tmpRoot, { ...deps, ocrModel: VISION_MODEL });

  extractPdf.mockResolvedValue([{ page: 1, text: PAGE_1_TEXT }]);
  embed.mockRejectedValueOnce(new EmbedderUnavailableError("connect ECONNREFUSED"));
  const otherModel = { ...deps, ocrModel: "openai/gpt-5.5-mini" };
  await expect(ingestDirectory(ORG_ID, tmpRoot, otherModel)).rejects.toThrow(/ECONNREFUSED/);
  expect((await onlyDocument()).emptyExtractionBy).toBe(marker(`ocr:${VISION_MODEL}`));

  expect(await ingestDirectory(ORG_ID, tmpRoot, otherModel)).toEqual(counts({ indexed: 1 }));
  const doc = await onlyDocument();
  expect(doc.emptyExtractionBy).toBeNull();
  expect(await chunksFor(doc.id)).not.toHaveLength(0);
});

it("reads an empty document again once the extractor itself has changed", async () => {
  // A better scan heuristic, a higher page cap, a new pdfjs: none of them
  // changes the model's name, and all of them can find text the last read
  // missed. The record names the extractor version so they reach the
  // documents already on record.
  const pdfPath = join(tmpRoot, "legacy-scan.pdf");
  writeFileSync(pdfPath, "fake-old-extractor-scan");
  const contentHash = createHash("sha256").update("fake-old-extractor-scan").digest("hex");
  await db.insert(kbDocuments).values({
    orgId: ORG_ID,
    contentHash,
    sourcePath: pdfPath,
    emptyExtractionBy: `${EXTRACTION_VERSION - 1}|no-ocr`,
  });

  const { deps, extractPdf } = fakeDeps(BLANK_SCAN);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
  expect(extractPdf).toHaveBeenCalledTimes(1);
  expect((await onlyDocument()).emptyExtractionBy).toBe(marker("no-ocr"));
});

it("does not read an empty workbook again when a vision model appears", async () => {
  // OCR reads scanned pages; it has nothing to say about hidden sheets.
  writeFileSync(join(tmpRoot, "internal.xlsx"), "fake-xlsx-bytes");
  const { deps, extractXlsx } = fakeDeps(undefined, EMPTY_XLSX);

  await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(await ingestDirectory(ORG_ID, tmpRoot, { ...deps, ocrModel: VISION_MODEL })).toEqual(
    counts({ skipped: 1 })
  );
  expect(extractXlsx).toHaveBeenCalledTimes(1);
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
      ocrModel: null,
      stagingDir,
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

// The counterpart to the test above: an embedder that cannot embed anything is
// ONE outage, not N corrupt files. Swallowing it per file would report "193
// failed" for a systemic problem, bury the actual cause, and pointlessly parse
// the whole corpus on the way. The embedder says which it is by type
// (`EmbedderUnavailableError`), so the run stops on it and surfaces it.
it("surfaces an embedding outage as a run failure instead of blaming every file", async () => {
  writeFileSync(join(tmpRoot, "a.pdf"), "bytes-a");
  writeFileSync(join(tmpRoot, "b.pdf"), "bytes-b");

  const embed = vi.fn(async () => {
    throw new EmbedderUnavailableError("connect ECONNREFUSED 127.0.0.1:11434");
  });
  const extractPdf = vi.fn(async () => [{ page: 1, text: PAGE_1_TEXT }]);

  await expect(
    ingestDirectory(ORG_ID, tmpRoot, {
      embed,
      extractPdf,
      extractXlsx: neverCalledXlsx,
      convertOffice: neverCalledConvert,
      ocrModel: null,
      stagingDir,
    })
  ).rejects.toThrow(/ECONNREFUSED/);
  // Bailed on the first file rather than walking the rest of the corpus.
  expect(embed).toHaveBeenCalledTimes(1);
});

// #1380. The embedder refusing ONE file's text says nothing about the next
// file: a first reindex of 14,000 documents stopped at file 2,285 on every run
// because one chunk was longer than the local context, and the error took the
// whole job down with it.
it("keeps indexing the next file when the embedder refuses one file's text", async () => {
  const TOO_LONG = "Part numbers 4711-0815-2342 that tokenize far denser than prose.";
  writeFileSync(join(tmpRoot, "a-dense.pdf"), "dense-bytes");
  writeFileSync(join(tmpRoot, "b-good.pdf"), "good-bytes");
  const embed = vi.fn(async (texts: string[]) => {
    if (texts.some((t) => t.includes(TOO_LONG))) {
      throw new Error("Input is longer than the context size. Try to increase the context size");
    }
    return texts.map(() => Array(768).fill(0.1));
  });
  const deps: IngestDeps = {
    embed,
    extractPdf: vi.fn(async (path: string) => [
      { page: 1, text: path.endsWith("a-dense.pdf") ? TOO_LONG : PAGE_1_TEXT },
    ]),
    extractXlsx: neverCalledXlsx,
    convertOffice: neverCalledConvert,
    ocrModel: null,
    stagingDir,
  };

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let result: IngestResult;
  try {
    result = await ingestDirectory(ORG_ID, tmpRoot, deps);

    // The server log says which file and why — never what it contains.
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(join(tmpRoot, "a-dense.pdf"));
    expect(logged).toContain("longer than the context size");
    expect(logged).not.toContain(TOO_LONG);
  } finally {
    consoleError.mockRestore();
  }
  expect(result).toEqual(counts({ indexed: 1, failed: 1 }));

  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs.map((d) => d.sourcePath)).toEqual([join(tmpRoot, "b-good.pdf")]);

  // And it is owed, not forgotten: the next run tries it again.
  const { deps: healthy } = fakeDeps([{ page: 1, text: TOO_LONG }]);
  expect(await ingestDirectory(ORG_ID, tmpRoot, healthy)).toEqual(
    counts({ indexed: 1, skipped: 1 })
  );
});

// The other half of #1380: a chunk the embedder cannot take whole is cut into
// pieces it can, each stored as a chunk of its own under the same locator, so
// a citation still points at the page the text came from.
it("stores a chunk too long for the embedder as several chunks under the same locator", async () => {
  writeFileSync(join(tmpRoot, "dense.pdf"), "dense-bytes");
  const { deps, embed } = fakeDeps([{ page: 3, text: PAGE_1_TEXT }]);
  const fitForEmbedding = vi.fn(async (texts: string[]) =>
    texts.map((t) => [t.slice(0, 40), t.slice(40)])
  );

  expect(await ingestDirectory(ORG_ID, tmpRoot, { ...deps, fitForEmbedding })).toEqual(
    counts({ indexed: 1 })
  );

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const rows = await chunksFor(doc.id);
  expect(rows.map((r) => r.chunkText)).toEqual([PAGE_1_TEXT.slice(0, 40), PAGE_1_TEXT.slice(40)]);
  expect(rows.map((r) => r.locator)).toEqual([
    { kind: "page", page: 3 },
    { kind: "page", page: 3 },
  ]);
  // One vector per stored piece: what is embedded is exactly what is written.
  expect(embed.mock.calls.flatMap(([texts]) => texts)).toEqual([
    PAGE_1_TEXT.slice(0, 40),
    PAGE_1_TEXT.slice(40),
  ]);
});

// postgres.js refuses a statement once it binds 65,534 parameters, and a
// kb_chunks row binds 8 — so one INSERT holds at most 8,191 chunks, counted
// after `fitForEmbedding` has split them. A document above that failed as a
// file, rolled back, left no row behind to count its failed reads against, and
// was read (OCR included) and embedded again on every run.
it("writes a document with more chunks than one INSERT can bind", async () => {
  writeFileSync(join(tmpRoot, "long.pdf"), "long-bytes");
  const { deps } = fakeDeps([{ page: 1, text: PAGE_1_TEXT }]);
  const pieces = 8_200;
  const fitForEmbedding = async (texts: string[]) =>
    texts.map(() => Array.from({ length: pieces }, (_, i) => `piece ${i}`));
  const vector = Array(768).fill(0.001);
  const embed = async (texts: string[]) => texts.map(() => vector);

  expect(await ingestDirectory(ORG_ID, tmpRoot, { ...deps, fitForEmbedding, embed })).toEqual(
    counts({ indexed: 1 })
  );

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const [{ stored }] = await db
    .select({ stored: count() })
    .from(kbChunks)
    .where(eq(kbChunks.documentId, doc.id));
  expect(stored).toBe(pieces);
});

/**
 * Counts the kb_chunks INSERT statements issued inside `db.transaction`, so a
 * test can tell one statement from several. Everything else passes through.
 */
function countChunkInserts() {
  const original = db.transaction.bind(db);
  let inserts = 0;
  const spy = vi.spyOn(db, "transaction").mockImplementation(((
    fn: (tx: unknown) => Promise<unknown>,
    config?: unknown
  ) =>
    original(async (tx) => {
      const insert = tx.insert.bind(tx);
      tx.insert = ((table: Parameters<typeof tx.insert>[0]) => {
        if (table === kbChunks) inserts++;
        return insert(table);
      }) as typeof tx.insert;
      return fn(tx);
    }, config as never)) as never);
  return { inserts: () => inserts, restore: () => spy.mockRestore() };
}

it("writes a document's chunks in several INSERTs when they outnumber one batch", async () => {
  insertBatchOverride.rows = 2;
  writeFileSync(join(tmpRoot, "split.pdf"), "split-bytes");
  const { deps } = fakeDeps([{ page: 4, text: PAGE_1_TEXT }]);
  const pieces = ["one", "two", "three", "four", "five"];
  const fitForEmbedding = async (texts: string[]) => texts.map(() => pieces);

  const counter = countChunkInserts();
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, { ...deps, fitForEmbedding })).toEqual(
      counts({ indexed: 1 })
    );
    expect(counter.inserts()).toBe(3);
  } finally {
    counter.restore();
  }

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const rows = await chunksFor(doc.id);
  expect(rows.map((r) => r.chunkText).sort()).toEqual([...pieces].sort());
  expect(new Set(rows.map((r) => JSON.stringify(r.locator)))).toEqual(
    new Set([JSON.stringify({ kind: "page", page: 4 })])
  );
});

// Batches are statements, not transactions: a refusal in the second leaves the
// first unwritten too, and the stored document exactly as it was.
it("leaves the stored document unchanged when a later batch is refused", async () => {
  const path = join(tmpRoot, "handbook.pdf");
  writeFileSync(path, "first-bytes");
  const { deps } = fakeDeps();
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  const [before] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const chunksBefore = await chunksFor(before.id);
  expect(chunksBefore.length).toBeGreaterThan(0);

  insertBatchOverride.rows = 2;
  writeFileSync(path, "second-bytes");
  const fitForEmbedding = async (texts: string[]) =>
    texts.map((_, i) => (i === 0 ? ["a", "b", "c", "d", "e"] : []));
  // pgvector refuses a vector with a NaN in it; piece 4 sits in batch 2.
  const embed = async (texts: string[]) =>
    texts.map((t) => Array(768).fill(t === "d" ? Number.NaN : 0.002));

  expect(await ingestDirectory(ORG_ID, tmpRoot, { ...deps, fitForEmbedding, embed })).toEqual(
    counts({ failed: 1 })
  );

  const [after] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(after).toEqual(before);
  const sortById = (rows: { id: string }[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  expect(sortById(await chunksFor(before.id))).toEqual(sortById(chunksBefore));
});

it("stops the run when the database connection is lost mid-run", async () => {
  writeFileSync(join(tmpRoot, "a-first.pdf"), "first-bytes");
  writeFileSync(join(tmpRoot, "b-second.pdf"), "second-bytes");
  const { deps, embed } = fakeDeps([{ page: 1, text: PAGE_1_TEXT }]);
  const lost = Object.assign(new Error("write CONNECTION_CLOSED db:5432"), {
    code: "CONNECTION_CLOSED",
  });
  const wrapped = new Error("Failed query: insert into kb_documents … params: …", { cause: lost });
  const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(wrapped);
  try {
    await expect(ingestDirectory(ORG_ID, tmpRoot, deps)).rejects.toBe(lost);
  } finally {
    transaction.mockRestore();
  }
  // Stopped at the first file instead of embedding the rest of the corpus.
  expect(embed).toHaveBeenCalledTimes(1);
});

// A full disk while one file is copied to staging costs that file, not the
// run: one file larger than the space left would otherwise stop every run at
// the same place, which is the failure #1380 removes.
it("counts a file whose staging copy hits a full disk as failed and goes on", async () => {
  writeFileSync(join(tmpRoot, "a-first.pdf"), "first-bytes");
  writeFileSync(join(tmpRoot, "b-second.pdf"), "second-bytes");
  const extractPdf = vi.fn(async (absPath: string) => {
    if (absPath.endsWith("a-first.pdf")) {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return [{ page: 1, text: PAGE_1_TEXT }];
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await ingestDirectory(ORG_ID, tmpRoot, {
      embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.1))),
      extractPdf,
      extractXlsx: neverCalledXlsx,
      convertOffice: neverCalledConvert,
      ocrModel: null,
      stagingDir,
    });
    expect(result).toEqual(counts({ indexed: 1, failed: 1 }));
  } finally {
    consoleError.mockRestore();
  }
  expect(extractPdf).toHaveBeenCalledTimes(2);
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
    ocrModel: null,
    stagingDir,
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

// #1366. Postgres `text` and `jsonb` cannot hold U+0000, and a PDF text layer
// with a broken font encoding emits it routinely. Only Postgres rejects it, so
// only a real-DB test sees it: the batched chunk insert failed and took the
// whole run down — on the same file, on every run, forever.
it("indexes a document whose extracted text holds NUL and other control characters", async () => {
  const pdfPath = join(tmpRoot, "supplier-sheet.pdf");
  writeFileSync(pdfPath, "pdf-with-nul-bytes");

  const { deps } = fakeDeps([
    { page: 1, text: `Quality cert\u0000ificate for incoming goods.\u0001\u001fValid until 2027.` },
    { page: 2, text: "Line one\tcolumn\r\nLine two\fafter a form feed." },
  ]);

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const texts = (await chunksFor(doc.id)).map((chunk) => chunk.chunkText).join("\n");
  // NUL goes without a trace — it sits between the letters of a word.
  expect(texts).toContain("Quality certificate for incoming goods.");
  // The other C0 controls become a space, so the words either side stay apart.
  expect(texts).toContain("goods.  Valid until 2027.");
  // Tab, CR and LF are text, not noise.
  expect(texts).toContain("Line one\tcolumn");
  expect(texts).toContain("Line two after a form feed.");
  expect(texts).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
});

it("indexes a workbook whose sheet name holds a NUL, which the locator carries into jsonb", async () => {
  writeFileSync(join(tmpRoot, "suppliers.xlsx"), "fake-xlsx-bytes");
  const { deps } = fakeDeps(undefined, {
    chunks: [{ text: SHEET_ROWS_TEXT, sheet: "Supp\u0000liers", startRow: 2, endRow: 3 }],
    sheets: ["Supp\u0000liers"],
    hiddenSheets: [],
    hiddenRows: 0,
  });

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const [chunk] = await chunksFor(doc.id);
  expect(chunk.locator).toEqual({ kind: "sheet", sheet: "Suppliers", startRow: 2, endRow: 3 });
});

it("does not write a chunk that held nothing but control characters", async () => {
  writeFileSync(join(tmpRoot, "binary-noise.pdf"), "noise");
  const { deps, embed } = fakeDeps([{ page: 1, text: "\u0000\u0001\u0000\u0002\u0000" }]);

  // Nothing readable is left, so it is listed as unreadable — not indexed with
  // an empty chunk the embedder was asked to vectorise.
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
  expect(embed).not.toHaveBeenCalled();
});

/**
 * Deps whose embedder hands back a vector of the wrong width for the chunks of
 * `rejectedText` — a value `vector(768)` refuses on insert, which is how a test
 * gets a real Postgres rejection for one file's rows and not the next file's.
 */
function rejectingDeps(rejectedText: string, pagesFor: (path: string) => IngestPage[]) {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map((text) => Array(text.includes(rejectedText) ? 3 : 768).fill(0.01))
  );
  const deps: IngestDeps = {
    embed,
    extractPdf: vi.fn(async (path: string) => pagesFor(path)),
    extractXlsx: neverCalledXlsx,
    convertOffice: neverCalledConvert,
    ocrModel: null,
    stagingDir,
  };
  return { deps, embed };
}

const REJECTED_TEXT = "These rows are refused by the database for one reason or another.";

// #1366, the containment half. Whatever the next thing a database refuses about
// one document's content turns out to be, it is a property of THAT document —
// like a PDF that does not parse — and costs that document only.
it("counts a file whose rows the database refuses as failed, and indexes the next one", async () => {
  writeFileSync(join(tmpRoot, "a-refused.pdf"), "refused-bytes");
  writeFileSync(join(tmpRoot, "b-good.pdf"), "good-bytes");
  const { deps } = rejectingDeps(REJECTED_TEXT, (path) => [
    { page: 1, text: path.endsWith("a-refused.pdf") ? REJECTED_TEXT : PAGE_1_TEXT },
  ]);

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let result: IngestResult;
  try {
    result = await ingestDirectory(ORG_ID, tmpRoot, deps);

    // One line naming the file and what the database said. Not the failed
    // query: drizzle's message quotes every parameter — the document's text
    // and its vectors — and would push the reason past the line's bound.
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(join(tmpRoot, "a-refused.pdf"));
    expect(logged).toMatch(/expected 768 dimensions/);
    expect(logged).not.toContain(REJECTED_TEXT);
    expect(logged).not.toContain("Failed query");
  } finally {
    consoleError.mockRestore();
  }
  expect(result).toEqual(counts({ indexed: 1, failed: 1 }));

  // No half-written row: a document row without its chunks would read as
  // "indexed, nothing found" in the unreadable list.
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs.map((d) => d.sourcePath)).toEqual([join(tmpRoot, "b-good.pdf")]);
  expect(await chunksFor(docs[0].id)).not.toHaveLength(0);
});

it("tries a file the database refused again on the next run", async () => {
  writeFileSync(join(tmpRoot, "refused.pdf"), "refused-bytes");
  const refusing = rejectingDeps(REJECTED_TEXT, () => [{ page: 1, text: REJECTED_TEXT }]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, refusing.deps)).toEqual(counts({ failed: 1 }));
  } finally {
    consoleError.mockRestore();
  }

  // Same bytes, and this time the write goes through: nothing on record made
  // the file look done.
  const { deps } = fakeDeps([{ page: 1, text: REJECTED_TEXT }]);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
});

it("keeps the last indexed version when the database refuses a changed file's new rows", async () => {
  const pdfPath = join(tmpRoot, "policy.pdf");
  writeFileSync(pdfPath, "good-bytes-v1");
  const { deps } = fakeDeps([{ page: 1, text: PAGE_1_TEXT }]);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  const [docBefore] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  const chunksBefore = await chunksFor(docBefore.id);

  writeFileSync(pdfPath, "changed-bytes-v2");
  const refusing = rejectingDeps(REJECTED_TEXT, () => [{ page: 1, text: REJECTED_TEXT }]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, refusing.deps)).toEqual(counts({ failed: 1 }));
  } finally {
    consoleError.mockRestore();
  }

  // Same rule as a changed file that fails to parse: the old version is
  // deleted only together with writing the new one.
  const docsAfter = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docsAfter).toHaveLength(1);
  expect(docsAfter[0].id).toBe(docBefore.id);
  expect(docsAfter[0].contentHash).toBe(docBefore.contentHash);
  expect(await chunksFor(docBefore.id)).toHaveLength(chunksBefore.length);
});

// The other half: an error that says nothing about the file must still stop
// the run. Counted per file instead, a database restart mid-reindex would read
// as one "failed" document for every file still to come, and the job as done.
it("stops the run when the database fails for a reason that is not the file", async () => {
  writeFileSync(join(tmpRoot, "a-first.pdf"), "first-bytes");
  writeFileSync(join(tmpRoot, "b-second.pdf"), "second-bytes");
  const { deps, embed } = fakeDeps([{ page: 1, text: PAGE_1_TEXT }]);
  const shutdown = Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });
  const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(shutdown);
  try {
    await expect(ingestDirectory(ORG_ID, tmpRoot, deps)).rejects.toBe(shutdown);
  } finally {
    transaction.mockRestore();
  }

  expect(embed).toHaveBeenCalledTimes(1);
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toEqual([]);
});

it("keeps a chunkless document's record when the database refuses its rebuilt rows", async () => {
  writeFileSync(join(tmpRoot, "policy.pdf"), "bytes");
  const { deps } = fakeDeps([{ page: 1, text: PAGE_1_TEXT }]);
  await ingestDirectory(ORG_ID, tmpRoot, deps);
  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  await db.delete(kbChunks).where(eq(kbChunks.documentId, doc.id));

  const refusing = rejectingDeps(PAGE_1_TEXT, () => [{ page: 1, text: PAGE_1_TEXT }]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, refusing.deps)).toEqual(counts({ failed: 1 }));
  } finally {
    consoleError.mockRestore();
  }
  // The record is rewritten only together with its rows, so a refusal leaves
  // it exactly as it was.
  const [docAfter] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, doc.id));
  expect(docAfter).toEqual(doc);
  // Still owed: the next run rebuilds it.
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  expect(await chunksFor(doc.id)).not.toHaveLength(0);
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

// Skipping an unreadable root is right, but silent skipping is how an
// unmounted share reports "0 indexed, success" night after night. The caller
// decides what a skipped root means for its run; ingest just has to say.
it("tells the caller about a root it could not read", async () => {
  const onSkippedRoot = vi.fn();
  const missing = join(tmpRoot, "not-mounted");

  await ingestPaths(ORG_ID, [missing], fakeDeps().deps, { onSkippedRoot });

  expect(onSkippedRoot).toHaveBeenCalledWith(missing, "unreadable");
});

// A failed network mount under Docker is not an error, it is an EMPTY
// directory: the bind mount shows the bare mountpoint. From inside the
// container that is indistinguishable from a folder someone emptied, and
// taking it at its word deletes every document indexed from it. A caller that
// runs unattended can ask ingest not to.
it("keeps an emptied root's documents when asked to, and says it skipped the root", async () => {
  const share = join(tmpRoot, "share");
  writePdf(share, "handbook.pdf");
  writePdf(share, "policy.pdf", "policy");
  const { deps } = fakeDeps();
  await ingestPaths(ORG_ID, [share], deps);
  rmSync(join(share, "handbook.pdf"));
  rmSync(join(share, "policy.pdf"));
  const onSkippedRoot = vi.fn();

  const result = await ingestPaths(ORG_ID, [share], deps, {
    keepEmptiedFolders: true,
    onSkippedRoot,
  });

  expect(result).toEqual(counts());
  expect(onSkippedRoot).toHaveBeenCalledWith(share, "emptied");
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(2);
});

// Only a folder that HAD documents is suspicious when it comes up empty. A
// freshly granted empty folder is just empty.
it("treats a root that never held documents as simply empty, even when asked to keep emptied folders", async () => {
  const fresh = join(tmpRoot, "fresh");
  mkdirSync(fresh, { recursive: true });
  const onSkippedRoot = vi.fn();

  const result = await ingestPaths(ORG_ID, [fresh], fakeDeps().deps, {
    keepEmptiedFolders: true,
    onSkippedRoot,
  });

  expect(result).toEqual(counts());
  expect(onSkippedRoot).not.toHaveBeenCalled();
});

// The guard is about a folder that is empty as a WHOLE. A folder that still
// holds files reconciles as always: a deleted document leaves the index.
it("still removes a deleted document from a root that keeps other files, when asked to keep emptied folders", async () => {
  const share = join(tmpRoot, "share");
  writePdf(share, "handbook.pdf");
  writePdf(share, "policy.pdf", "policy");
  const { deps } = fakeDeps();
  await ingestPaths(ORG_ID, [share], deps);
  rmSync(join(share, "handbook.pdf"));

  const result = await ingestPaths(ORG_ID, [share], deps, { keepEmptiedFolders: true });

  expect(result).toEqual(counts({ skipped: 1, removed: 1 }));
});

// A failed mount does not have to BE the granted folder. Grant /data, mount
// a share at /data/contracts, and a failed mount leaves an empty /data/contracts
// inside a /data that still holds plenty — the whole-root check never fires,
// and the removal pass would delete every document the share held.
it("keeps the documents of an emptied folder below a root that still holds files", async () => {
  const data = join(tmpRoot, "data");
  writePdf(data, "readme.pdf", "readme");
  writePdf(join(data, "contracts"), "contract.pdf", "contract");
  writePdf(join(data, "contracts", "2024"), "invoice.pdf", "invoice");
  const { deps } = fakeDeps();
  await ingestPaths(ORG_ID, [data], deps);
  // The mount fails: the mountpoint is there, and empty.
  rmSync(join(data, "contracts"), { recursive: true, force: true });
  mkdirSync(join(data, "contracts"));
  const onKeptFolder = vi.fn();

  const result = await ingestPaths(ORG_ID, [data], deps, {
    keepEmptiedFolders: true,
    onKeptFolder,
  });

  expect(result).toEqual(counts({ skipped: 1 }));
  expect(onKeptFolder).toHaveBeenCalledWith(join(data, "contracts"));
  expect(onKeptFolder).toHaveBeenCalledTimes(1);
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(3);
});

// Overlapping grants are the same shape from the other side: /data/hr is its
// own root AND a folder inside /data. Skipping the /data/hr root is not
// enough if /data's removal pass then deletes what was under it.
it("keeps an emptied root's documents when an overlapping root also covers them", async () => {
  const data = join(tmpRoot, "data");
  const hr = join(data, "hr");
  writePdf(data, "readme.pdf", "readme");
  writePdf(hr, "policy.pdf", "policy");
  const { deps } = fakeDeps();
  await ingestPaths(ORG_ID, [data, hr], deps);
  rmSync(join(hr, "policy.pdf"));

  const result = await ingestPaths(ORG_ID, [data, hr], deps, { keepEmptiedFolders: true });

  expect(result.removed).toBe(0);
  expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(2);
});

// What the guard must NOT swallow: a folder somebody deleted is gone, not
// empty, and its documents leave the index like any deleted file's.
it("still removes the documents of a folder that was deleted outright", async () => {
  const data = join(tmpRoot, "data");
  writePdf(data, "readme.pdf", "readme");
  writePdf(join(data, "old-project"), "plan.pdf", "plan");
  const { deps } = fakeDeps();
  await ingestPaths(ORG_ID, [data], deps);
  rmSync(join(data, "old-project"), { recursive: true, force: true });
  const onKeptFolder = vi.fn();

  const result = await ingestPaths(ORG_ID, [data], deps, {
    keepEmptiedFolders: true,
    onKeptFolder,
  });

  expect(result).toEqual(counts({ skipped: 1, removed: 1 }));
  expect(onKeptFolder).not.toHaveBeenCalled();
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
    if (++embedCalls > 2) throw new EmbedderUnavailableError("connect ECONNREFUSED");
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

  const { deps, extractPdf, extractXlsx, handed } = fakeDeps();

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);

  expect(result).toEqual(counts({ indexed: 1 }));
  expectPrivateCopy(extractXlsx, handed, xlsxPath, "fake-xlsx-bytes-v1");
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

it("books a workbook refused as too large as unsearchable — listed, final, and not a failed run", async () => {
  // A compressed bomb is a verdict on THIS file: nothing a retry does changes
  // what its central directory declares. It must neither crash the run (the
  // reader refuses before inflating) nor vanish as `failed` with no row —
  // it lands in the same visible bucket a text-less scan does (#935), and is
  // not re-read on every reindex.
  const xlsxPath = join(tmpRoot, "bomb.xlsx");
  writeFileSync(xlsxPath, "fake-xlsx-bomb");
  const { deps, extractXlsx } = fakeDeps();
  extractXlsx.mockRejectedValue(
    new OfficeFileRejectedError("too_large", "Archive declared decompressed size is past the limit")
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
    // Unchanged on the next run: settled, so it is skipped rather than re-read.
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ skipped: 1 }));
    expect(extractXlsx).toHaveBeenCalledTimes(1);
    // The operator can tell which file and why, in the server log.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bomb.xlsx"));
  } finally {
    warn.mockRestore();
  }

  const listed = await listUnsearchableDocuments(ORG_ID, [tmpRoot]);
  expect(listed.documents.map((d) => d.sourcePath)).toEqual([xlsxPath]);
});

it("books a workbook refused for its content as unsearchable, and leaves it alone while it is unchanged", async () => {
  // Through the real reader: a number format no spreadsheet application
  // writes is refused before exceljs sees it. That is a verdict on these
  // bytes, as final as a bomb's — not a reader that broke, to be read again on
  // every run and never named in the unreadable list.
  const xlsxPath = join(tmpRoot, "formats.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Prices");
  sheet.addRow(["Item", "Price"]);
  sheet.addRow(["A-1", 0.15]).getCell(2).numFmt = `0%${"[".repeat(64)}`;
  await workbook.xlsx.writeFile(xlsxPath);

  const { deps } = fakeDeps();
  const extractXlsx = vi.fn((path: string) => realExtractXlsx(path));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const run = () => ingestDirectory(ORG_ID, tmpRoot, { ...deps, extractXlsx });
    expect(await run()).toEqual(counts({ unsearchable: 1 }));
    expect(await run()).toEqual(counts({ skipped: 1 }));
    expect(extractXlsx).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("formats.xlsx"));
  } finally {
    warn.mockRestore();
  }

  const listed = await listUnsearchableDocuments(ORG_ID, [tmpRoot]);
  expect(listed.documents.map((d) => d.sourcePath)).toEqual([xlsxPath]);
});

it("keeps a changed workbook's indexed version when its reader is killed without a verdict, and reads it again", async () => {
  // The container's OOM killer, aimed at the reader child by its
  // oom_score_adj, says nothing about THIS workbook — the memory may have been
  // the server's. Booked as "too large", it deleted the version already
  // indexed and recorded the new one as unreadable for good. The real
  // isolated reader is used, with a stub child that is SIGKILLed mid-read.
  const { runSheetReader } = await import("@/lib/knowledge/xlsx-isolated");
  const stubDir = mkdtempSync(join(tmpdir(), "pinchy-kb-ingest-stub-"));
  const killed = join(stubDir, "killed.mjs");
  writeFileSync(
    killed,
    `process.send({ type: "ready" }); process.on("message", () => process.kill(process.pid, "SIGKILL"));`
  );

  try {
    const xlsxPath = join(tmpRoot, "prices.xlsx");
    writeFileSync(xlsxPath, "fake-xlsx-bytes-v1");
    const { deps } = fakeDeps();
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
    const [before] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    const chunksBefore = await chunksFor(before.id);
    expect(chunksBefore).toHaveLength(1);

    writeFileSync(xlsxPath, "fake-xlsx-bytes-v2");
    const extractXlsx = vi.fn(
      async (path: string) =>
        (await runSheetReader({ op: "extract", path }, { entry: killed })) as XlsxExtraction
    );
    const run = () => ingestDirectory(ORG_ID, tmpRoot, { ...deps, extractXlsx });

    expect(await run()).toEqual(counts({ failed: 1 }));
    const after = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].contentHash).toBe(before.contentHash);
    expect(after[0].emptyExtractionBy).toBeNull();
    expect(await chunksFor(before.id)).toHaveLength(chunksBefore.length);

    // Not settled: the next run reads it again.
    expect(await run()).toEqual(counts({ failed: 1 }));
    expect(extractXlsx).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
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
    deps: {
      embed,
      extractPdf,
      extractXlsx: neverCalledXlsx,
      convertOffice,
      ocrModel: null,
      stagingDir,
    } as IngestDeps,
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

it("stores a Word heading that carried NUL without it (#1366)", async () => {
  // The Office branch reads through its own dispatch; the cleaning has to
  // cover it as well as the PDF and spreadsheet readers.
  writeFileSync(join(tmpRoot, "Handbuch.docx"), "fake-docx-bytes");
  const pages: IngestPage[] = [
    {
      ...WORD_PAGES[0],
      headings: [{ charStart: 0, headings: ["Quality\u0000 management"] }],
    },
  ];
  const { deps } = officeDeps(convertedTo("/artifacts/ab/ef.pdf"), () => pages);
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  for (const chunk of await chunksFor(doc.id)) {
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

it("names a refused Office document and the reason in the server log, once", async () => {
  // The unreadable list says THAT a file is unsearchable, never why; the
  // admin-facing counts must not name paths at all. The server log is the only
  // place an operator learns which document was refused and for what.
  const docPath = join(tmpRoot, "Angebot.doc");
  writeFileSync(docPath, "<html><body>not a Word document</body></html>");
  const reason = "refused before conversion: the content is HTML, not the format its name claims";

  const { deps } = officeDeps(
    (absPath) => ({ sourcePath: absPath, status: "failed", reason }),
    () => WORD_PAGES
  );

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
    const lines = warn.mock.calls.map(([line]) => String(line)).filter((l) => l.includes(docPath));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(reason);
  } finally {
    warn.mockRestore();
  }
});

/** What turns one log line into two, or reorders one on a terminal. */
const BREAKS_A_LINE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** The `[kb-ingest]` lines `warn` received, each as printed. */
const ingestLines = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[kb-ingest]"));

it("keeps a refused Office document's log entry to one bounded line, whatever its name and reason hold", async () => {
  // A file name is chosen by whoever put the file on the share — newlines
  // included — and a reason can quote what the file or the file system said.
  // Neither may write a line of its own into the server log, nor flood it.
  const docPath = join(tmpRoot, "Angebot\n[kb-ingest] Lohnliste.docx: not converted — FORGED.doc");
  writeFileSync(docPath, "fake-doc-bytes");
  const reason = `unreadable source: open '${docPath}'\n${"Q".repeat(3000)}\r\u2028\u0085\u202e`;

  const { deps } = officeDeps(
    (absPath) => ({ sourcePath: absPath, status: "failed", reason }),
    () => WORD_PAGES
  );

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
    const lines = ingestLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(BREAKS_A_LINE);
    expect(lines[0].length).toBeLessThan(1000);
    // Still names the file, escaped rather than dropped.
    expect(lines[0]).toContain("Angebot\\n[kb-ingest] Lohnliste.docx");
  } finally {
    warn.mockRestore();
  }
});

describe("the converter's log lines about a document", () => {
  // The converter reads private copies on the staging volume, each under the
  // file's own basename in a directory of its own — a name that reads like the
  // document and is not where an admin can find it.
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-ingest-names-"));
  });

  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
  });

  function namingDeps(prepareSource: PrepareSource): IngestDeps {
    return {
      embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.05))),
      extractPdf: vi.fn(async () => WORD_PAGES),
      extractXlsx: neverCalledXlsx,
      convertOffice: (sources: readonly OfficeSource[]) =>
        convertOfficeFiles(sources, {
          store: new OfficeArtifactStore(storeRoot),
          prepareSource,
          runConverter: async ({ inputs, outDir }) => {
            for (const staged of inputs) {
              const pdf = join(outDir, basename(staged, extname(staged)) + ".pdf");
              writeFileSync(pdf, "%PDF-1.4\nconverted words\n");
            }
            return { code: 0, signal: null, stderr: "" };
          },
          countPdfWords: async () => 10,
          countSourceWords: async () => null,
        }),
      ocrModel: null,
      stagingDir,
    };
  }

  it("names the share's file when an altChunk was cut — the asking document and its batch mate", async () => {
    const first = join(tmpRoot, "Angebot.docx");
    const second = join(tmpRoot, "Lohnliste.docx");
    writeFileSync(first, "first-docx-bytes");
    writeFileSync(second, "second-docx-bytes");
    const deps = namingDeps(async (_absPath, staged) => {
      writeFileSync(staged, "CHECKED COPY");
      return {
        relationshipsRemoved: 0,
        altChunksRemoved: 1,
        rtfGroupsRemoved: 0,
        unpackedBytes: null,
        contentHash: createHash("sha256").update(staged).digest("hex"),
      };
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 2 }));
      const cut = warn.mock.calls
        .map((call) => format(...call))
        .filter((line) => line.includes("altChunk"));
      expect(cut).toHaveLength(2);
      expect(cut.find((line) => line.includes(`${first}: cut 1 altChunk`))).toBeDefined();
      expect(cut.find((line) => line.includes(`${second}: cut 1 altChunk`))).toBeDefined();
      expect(cut.some((line) => line.includes(stagingDir))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("names the share's file in a refusal whose reason quotes the copy", async () => {
    const docPath = join(tmpRoot, "Lohnliste.docx");
    writeFileSync(docPath, "docx-bytes");
    const deps = namingDeps(async (absPath) => {
      throw new Error(`EACCES: permission denied, open '${absPath}'`);
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
      const lines = ingestLines(warn);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`open '${docPath}'`);
      expect(lines[0]).not.toContain(stagingDir);
    } finally {
      warn.mockRestore();
    }
  });
});

it("keeps a refused workbook's log entry to one bounded line, whatever its name and reason hold", async () => {
  const xlsxPath = join(tmpRoot, "Preise\n[kb-ingest] Lohnliste.xlsx: not read — FORGED.xlsx");
  writeFileSync(xlsxPath, "fake-xlsx");
  const { deps, extractXlsx } = fakeDeps();
  extractXlsx.mockRejectedValue(
    new OfficeFileRejectedError(
      "unexpected_content",
      `the sheet reader stopped: ${"Q".repeat(3000)}\n[kb-ingest] FORGED\u2028`
    )
  );

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ unsearchable: 1 }));
    const lines = ingestLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(BREAKS_A_LINE);
    expect(lines[0].length).toBeLessThan(1000);
    expect(lines[0]).toContain("Preise\\n[kb-ingest] Lohnliste.xlsx");
  } finally {
    warn.mockRestore();
  }
});

it("keeps a failed file's log entry to one bounded line, whatever its name holds", async () => {
  // The per-file failure line names the file, and a file name can carry a
  // newline: escaped, it still names the file without writing a line of its own.
  const pdfPath = join(tmpRoot, "Bericht\n[kb-ingest] Lohnliste.pdf: FORGED.pdf");
  writeFileSync(pdfPath, "corrupt-bytes");
  const extractPdf = vi.fn(async () => {
    throw new Error("Invalid PDF structure");
  });

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await ingestDirectory(ORG_ID, tmpRoot, {
      embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.1))),
      extractPdf,
      extractXlsx: neverCalledXlsx,
      convertOffice: neverCalledConvert,
      ocrModel: null,
      stagingDir,
    });
    expect(result).toEqual(counts({ failed: 1 }));
    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = String(consoleError.mock.calls[0][0]);
    expect(line).not.toMatch(BREAKS_A_LINE);
    expect(line.length).toBeLessThan(1100);
    expect(line).toContain("Bericht\\n[kb-ingest] Lohnliste.pdf");
    // What the log receives is every argument as console prints it, the cause
    // included: one line, still saying why.
    const printed = format(...consoleError.mock.calls[0]);
    expect(printed).not.toMatch(BREAKS_A_LINE);
    expect(printed).toContain("Invalid PDF structure");
  } finally {
    consoleError.mockRestore();
  }
});

it.skipIf(process.getuid?.() === 0)(
  "keeps an unreadable file's log entry to one line, though the file system's error quotes its name",
  async () => {
    // The cause is the file system's own error, and its message and stack
    // quote the path as the share spells it. Printed as it stands, a newline
    // in the name would write a line of its own. Skipped as root, whom the
    // mode bits do not stop.
    const pdfPath = join(tmpRoot, "Bericht\n[kb-ingest] Lohnliste.pdf: not converted — FORGED.pdf");
    writeFileSync(pdfPath, "%PDF-1.4 unreadable");
    await chmod(pdfPath, 0o000);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await ingestDirectory(ORG_ID, tmpRoot, {
        embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.1))),
        extractPdf: vi.fn(async () => {
          throw new Error("extractPdf reached a file it could not have read");
        }),
        extractXlsx: neverCalledXlsx,
        convertOffice: neverCalledConvert,
        ocrModel: null,
        stagingDir,
      });
      expect(result).toEqual(counts({ failed: 1 }));
      expect(consoleError).toHaveBeenCalledTimes(1);
      const printed = format(...consoleError.mock.calls[0]);
      expect(printed).not.toMatch(BREAKS_A_LINE);
      expect(printed).toContain("Bericht\\n[kb-ingest] Lohnliste.pdf");
      // Still enough to act on: what failed, and how.
      expect(printed).toContain("EACCES");
    } finally {
      consoleError.mockRestore();
      await chmod(pdfPath, 0o600);
    }
  }
);

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

describe("an artifact volume that cannot be written", () => {
  // The reader child writes each checked copy onto the artifact volume. A
  // full or read-only volume there is a squeeze on the machine, not a verdict
  // on the document: a CHANGED file must keep the version the index holds and
  // be read again next run, not be replaced by a row with no chunks.
  const runningAsRoot = process.getuid?.() === 0;
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-ingest-store-"));
  });

  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
  });

  /** The real converter, with `prepareSource` swapped and LibreOffice never reached. */
  function realConverterDeps(
    prepareSource: PrepareSource,
    runConverter: RunConverter = async () => {
      throw new Error("the converter must not run when nothing could be staged");
    },
    statfs?: ConvertOptions["statfs"]
  ) {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.05)));
    return {
      embed,
      extractPdf: vi.fn(async () => WORD_PAGES),
      extractXlsx: neverCalledXlsx,
      convertOffice: (sources: readonly OfficeSource[]) =>
        convertOfficeFiles(sources, {
          store: new OfficeArtifactStore(storeRoot),
          prepareSource,
          runConverter,
          statfs,
        }),
      ocrModel: null,
      stagingDir,
    } as IngestDeps;
  }

  async function expectOldVersionKept(
    prepareSource: PrepareSource,
    runConverter?: RunConverter,
    statfs?: ConvertOptions["statfs"]
  ) {
    const docPath = join(tmpRoot, "Angebot.doc");
    writeFileSync(docPath, "{\\rtf1 version one}");
    const good = officeDeps(convertedTo("/artifacts/v1.pdf"), () => WORD_PAGES);
    expect(await ingestDirectory(ORG_ID, tmpRoot, good.deps)).toEqual(counts({ indexed: 1 }));
    const [before] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    const chunksBefore = await chunksFor(before.id);
    expect(chunksBefore.length).toBeGreaterThan(0);

    writeFileSync(docPath, "{\\rtf1 version two}");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await ingestDirectory(
          ORG_ID,
          tmpRoot,
          realConverterDeps(prepareSource, runConverter, statfs)
        )
      ).toEqual(counts({ failed: 1 }));
      // Reported once, as the failed run it is — never also as a refusal of
      // the document, which the volume check just took back.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(docPath),
        expect.anything()
      );
      expect(warn.mock.calls.filter(([line]) => String(line).includes(docPath))).toEqual([]);
    } finally {
      consoleError.mockRestore();
      warn.mockRestore();
    }

    const [after] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    expect(after.id).toBe(before.id);
    expect(after.contentHash).toBe(before.contentHash);
    expect((await chunksFor(after.id)).map((c) => c.id).sort()).toEqual(
      chunksBefore.map((c) => c.id).sort()
    );
  }

  it("keeps the last indexed version when the volume is full", async () => {
    await expectOldVersionKept(async () => {
      throw new StagedCopyWriteError("ENOSPC: no space left on device, write");
    });
  });

  it.skipIf(runningAsRoot)(
    "keeps the last indexed version when the staging directory may not be written to",
    async () => {
      // Through the real reader child. Skipped as root, which the mode bits
      // do not stop.
      await expectOldVersionKept(async (absPath, staged) => {
        await chmod(dirname(staged), 0o500);
        return stageOfficeSourceIsolated(absPath, staged);
      });
    }
  );

  it("keeps the last indexed version when the converted PDF cannot be written", async () => {
    // The copy fit; the PDF, written to the same volume right after, did not.
    // What the real `soffice` does then: exit 0, no PDF, one stderr line —
    // and the volume reports what a nearly full one reports: 4 KB left.
    await expectOldVersionKept(
      async () => null,
      async ({ outDir }) => ({
        code: 0,
        signal: null,
        stderr: `Error: Please verify input parameters... (SfxBaseModel::impl_store <file://${join(outDir, "0.pdf")}> failed: 0x909(Error Area:Io Class:Space Code:9) at ./sfx2/source/doc/sfxbasemodel.cxx:3207)\n`,
      }),
      async () => ({ bsize: 4096, bavail: 1, files: 1_000_000, ffree: 1_000_000 })
    );
  });

  it("lists an all-hidden deck as unsearchable: LibreOffice's failed store on a roomy volume is the document's", async () => {
    // The real binary prints the same `impl_store … failed … Error Area:Io`
    // for a .pptx whose every slide is hidden — on a volume with room. That
    // is a verdict on the deck, not a full disk to retry forever.
    const deckPath = join(tmpRoot, "Praesentation.pptx");
    writeFileSync(deckPath, "deck bytes");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await ingestDirectory(
          ORG_ID,
          tmpRoot,
          realConverterDeps(
            async () => null,
            async ({ outDir }) => ({
              code: 0,
              signal: null,
              stderr: `Error: Please verify input parameters... (SfxBaseModel::impl_store <file://${join(outDir, "0.pdf")}> failed: 0xc10(Error Area:Io Class:Write Code:16) at ./sfx2/source/doc/sfxbasemodel.cxx:3207)\n`,
            })
          )
        )
      ).toEqual(counts({ unsearchable: 1 }));
      // The verdict that stands after the volume was ruled out is the one the
      // operator is told, with LibreOffice's own words for it.
      const lines = warn.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes(deckPath));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("no artifact produced");
    } finally {
      consoleError.mockRestore();
      warn.mockRestore();
    }
  });
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

it("batches from the document that asked, carrying the hash of the bytes it hands over", async () => {
  // Two properties of the same call, because they are the same decision.
  //
  // A batch sliced from the HEAD of the queue drags every Office document
  // before the changed one through the converter — and those are exactly the
  // documents the run is about to skip, so the work is thrown away. Worse, it
  // is not free: every document in a batch is read in full and copied before
  // the converter sees it, even for a cache hit.
  //
  // And the hash is the artifact key. The converter is handed private copies
  // (never a path on the share, which a swap could redirect), so the ingest
  // has read every document in the batch already and passes each one's hash:
  // `OfficeSource.contentHash` exists so that read is not paid for twice.
  for (let i = 0; i < 3; i++) writeFileSync(join(tmpRoot, `doc-${i}.docx`), `bytes-${i}`);

  const handedBytes = new Map<string, string>();
  const { deps, convertOffice } = officeDeps(
    (absPath) => {
      handedBytes.set(absPath, readFileSync(absPath, "utf8"));
      return convertedTo("/artifacts/batch.pdf")(absPath);
    },
    () => WORD_PAGES
  );
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 3 }));
  expect(convertOffice).toHaveBeenCalledTimes(1);

  const hashOf = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const sourcesOf = (call: number) =>
    convertOffice.mock.calls[call][0].map((source: { absPath: string; contentHash?: string }) => ({
      name: basename(source.absPath),
      onShare: source.absPath.startsWith(tmpRoot),
      bytes: handedBytes.get(source.absPath),
      contentHash: source.contentHash,
    }));

  // A first run needs every document, so the batch is still the whole queue.
  expect(sourcesOf(0)).toEqual(
    [0, 1, 2].map((i) => ({
      name: `doc-${i}.docx`,
      onShare: false,
      bytes: `bytes-${i}`,
      contentHash: hashOf(`bytes-${i}`),
    }))
  );

  // Only the LAST document changes, so the two before it are skipped and must
  // never reach the converter again.
  const changed = join(tmpRoot, "doc-2.docx");
  writeFileSync(changed, "bytes-2-v2");
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ skipped: 2, indexed: 1 }));

  expect(convertOffice).toHaveBeenCalledTimes(2);
  expect(sourcesOf(1)).toEqual([
    { name: "doc-2.docx", onShare: false, bytes: "bytes-2-v2", contentHash: hashOf("bytes-2-v2") },
  ]);
});

it("hashes an Office file as it streams, so the server never holds it whole while it converts", async () => {
  // The hash was taken from a whole-file read, and V8 kept that buffer alive
  // across the awaits after it — through the whole conversion: up to 200 MB
  // of the web process for one deck, on top of the embedding model, during
  // the very step the reader child exists to keep off the server.
  const docPath = join(tmpRoot, "Handbuch.docx");
  writeFileSync(docPath, "handbook-bytes");
  const { deps, convertOffice } = officeDeps(convertedTo("/artifacts/hb.pdf"), () => WORD_PAGES);
  wholeFileReads.length = 0;

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));

  // The converter is handed the private copy of the verified bytes, never the
  // share's path, with the hash the ingest took as it streamed.
  const [handed] = convertOffice.mock.calls[0][0] as OfficeSource[];
  expect(handed.contentHash).toBe(createHash("sha256").update("handbook-bytes").digest("hex"));
  expect(dirname(dirname(handed.absPath))).toBe(stagingDir);
  expect(basename(handed.absPath)).toBe("Handbuch.docx");
  // `wholeFileReads` sees `fs/promises.readFile` only; that no source is read
  // through `FileHandle.readFile` either is ingest-source-memory's to prove.
  expect(wholeFileReads).not.toContain(docPath);
  expect(wholeFileReads).not.toContain(handed.absPath);
});

it("converts a batch mate again when it was saved between its batch and its own turn", async () => {
  // A batch mate is converted from the copy taken when the batch was built,
  // but its row is written from the copy its own turn takes. A save in
  // between used to leave the two apart for good: the row recorded the new
  // bytes' hash (so every later run skips it) while its chunks came from the
  // old artifact — and the citation viewer, which keys the artifact on the
  // hash of the file it opens, found none and answered 404 forever.
  writeFileSync(join(tmpRoot, "a.pptx"), "A-v1");
  writeFileSync(join(tmpRoot, "b.pptx"), "B-v1");
  const hashOf = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

  // The real store, written the way the converter writes it: keyed on the
  // hash it is handed, holding what the copy said.
  const store = new OfficeArtifactStore(join(stagingDir, "artifacts"));
  const converted: string[][] = [];
  const convertOffice = vi.fn(async (sources: readonly OfficeSource[]) => {
    converted.push(sources.map((source) => readFileSync(source.absPath, "utf8")));
    return sources.map((source) => {
      const artifactPath = store.pathFor(source.contentHash!);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, readFileSync(source.absPath, "utf8"));
      return { sourcePath: source.absPath, status: "converted" as const, artifactPath };
    });
  });
  const deps: IngestDeps = {
    embed: async (texts) => texts.map(() => Array(768).fill(0.05)),
    extractPdf: async (artifact) => [
      { page: 1, text: `Slide text: ${readFileSync(artifact, "utf8")}. ${PAGE_1_TEXT}` },
    ],
    extractXlsx: neverCalledXlsx,
    convertOffice,
    ocrModel: null,
    stagingDir,
  };

  const mate = join(tmpRoot, "b.pptx");
  let saved = false;
  expect(
    await ingestDirectory(ORG_ID, tmpRoot, deps, {
      onProgress: (progress) => {
        // a.pptx is behind us, and b.pptx was converted with it — from B-v1.
        if (progress.processed === 1 && !saved) {
          saved = true;
          writeFileSync(mate, "B-v2");
        }
      },
    })
  ).toEqual(counts({ indexed: 2 }));
  expect(saved).toBe(true);
  expect(converted[0]).toEqual(["A-v1", "B-v1"]);

  const [row] = await db.select().from(kbDocuments).where(eq(kbDocuments.sourcePath, mate));
  expect(row.contentHash).toBe(hashOf("B-v2"));
  const texts = (await chunksFor(row.id)).map((chunk) => chunk.chunkText).join("\n");
  expect(texts).toContain("B-v2");
  expect(texts).not.toContain("B-v1");

  // What the citation viewer does: hash the file it opens, look the artifact up.
  const artifact = await store.get(hashOf(readFileSync(mate, "utf8")));
  expect(artifact).not.toBeNull();
  expect(readFileSync(artifact!, "utf8")).toBe("B-v2");
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
  const deps = {
    embed,
    extractPdf,
    extractXlsx: neverCalledXlsx,
    convertOffice,
    ocrModel: null,
    stagingDir,
  } as IngestDeps;

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

describe("an Office document converted under an earlier artifact format", () => {
  // AGENTS.md § "Test Migrations Against Pre-Existing Data". Changing the
  // conversion rules bumps OFFICE_ARTIFACT_FORMAT_VERSION, which moves the
  // store to a new directory — but an UNCHANGED document never asks the store
  // for anything: its hash matches and it has chunks. The upgrade state is a
  // document whose chunks came from the old artifact, read by code with new
  // rules, and every test that starts from an empty database is blind to it.
  //
  // What the earlier conversion produced is what makes this matter: an
  // artifact converted before the relationship allow-list may hold text a
  // planted document drew in from the server's disk.
  const LEAKED = "root:x:0:0:root:/root:/bin/bash daemon:x:1:1:daemon:/usr/sbin";
  const CLEAN = "Every delivery is checked against the order before it goes into storage.";
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-ingest-format-"));
  });

  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
  });

  /**
   * The real converter over a store at `formatVersion` (the current one when
   * omitted), with LibreOffice replaced by a stand-in that writes `text` as
   * every PDF, and the extractor reading that text back.
   */
  function converterDeps(
    formatVersion: number | undefined,
    text: string,
    prepareSource: PrepareSource = async () => null
  ) {
    const store = new OfficeArtifactStore(storeRoot, formatVersion ? { formatVersion } : {});
    const runConverter = vi.fn<RunConverter>(async ({ inputs, outDir }) => {
      for (const staged of inputs) {
        const pdf = join(outDir, basename(staged, extname(staged)) + ".pdf");
        writeFileSync(pdf, `%PDF-1.4\n${text}\n`);
      }
      return { code: 0, signal: null, stderr: "" };
    });
    const deps: IngestDeps = {
      embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.05))),
      extractPdf: vi.fn(async (artifact: string) => [
        { page: 1, text: readFileSync(artifact, "utf8").replace("%PDF-1.4", "").trim() },
      ]),
      extractXlsx: neverCalledXlsx,
      convertOffice: (sources: readonly OfficeSource[]) =>
        convertOfficeFiles(sources, {
          store,
          runConverter,
          prepareSource,
          countPdfWords: async () => 10,
          countSourceWords: async () => null,
        }),
      ocrModel: null,
      stagingDir,
    };
    return { deps, store, runConverter };
  }

  /** `docPath`, indexed under format version 1, its chunks carrying `LEAKED`. */
  async function indexedUnderFormatOne(docPath: string) {
    writeFileSync(docPath, "{\\rtf1 Angebot}");
    const earlier = converterDeps(1, LEAKED);
    expect(await ingestDirectory(ORG_ID, tmpRoot, earlier.deps)).toEqual(counts({ indexed: 1 }));
    expect(await earlier.store.get(sha256(docPath))).not.toBeNull();

    // The row as the upgrade finds it: written before the version its chunks
    // were read from was recorded on it.
    await db
      .update(kbDocuments)
      .set({ artifactFormatVersion: null })
      .where(eq(kbDocuments.orgId, ORG_ID));

    const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    const chunks = await chunksFor(doc.id);
    expect(chunks.map((chunk) => chunk.chunkText).join("\n")).toContain(LEAKED);
    return { doc, chunks };
  }

  function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  it("converts it again under the current rules and replaces the chunks the earlier artifact gave", async () => {
    const docPath = join(tmpRoot, "Angebot.doc");
    const { doc: before, chunks: chunksBefore } = await indexedUnderFormatOne(docPath);

    const current = converterDeps(undefined, CLEAN);
    expect(await ingestDirectory(ORG_ID, tmpRoot, current.deps)).toEqual(counts({ indexed: 1 }));

    // Converted again, into the store the preview reads.
    expect(current.runConverter).toHaveBeenCalledTimes(1);
    expect(current.store.formatVersion).toBe(OFFICE_ARTIFACT_FORMAT_VERSION);
    expect(await current.store.get(sha256(docPath))).not.toBeNull();

    // Same document, new chunks: none of the earlier ones survive.
    const [after] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    expect(after.id).toBe(before.id);
    const chunksAfter = await chunksFor(after.id);
    expect(chunksAfter.length).toBeGreaterThan(0);
    const earlierIds = new Set(chunksBefore.map((chunk) => chunk.id));
    expect(chunksAfter.some((chunk) => earlierIds.has(chunk.id))).toBe(false);
    const text = chunksAfter.map((chunk) => chunk.chunkText).join("\n");
    expect(text).toContain(CLEAN);
    expect(text).not.toContain(LEAKED);

    // Once is enough: the next run finds it current and leaves it alone.
    expect(await ingestDirectory(ORG_ID, tmpRoot, current.deps)).toEqual(counts({ skipped: 1 }));
    expect(current.runConverter).toHaveBeenCalledTimes(1);
  });

  it("drops the earlier artifact's chunks when the current rules refuse the document", async () => {
    // The case the bump exists for: a document the new rules will not convert
    // at all. Keeping the chunks the old conversion gave would keep exactly
    // what the new rules refuse searchable.
    const docPath = join(tmpRoot, "Angebot.doc");
    const { doc: before } = await indexedUnderFormatOne(docPath);

    const current = converterDeps(undefined, CLEAN, async () => {
      throw new OfficeFileRejectedError("unexpected_content", "not what its name says");
    });
    expect(await ingestDirectory(ORG_ID, tmpRoot, current.deps)).toEqual(
      counts({ unsearchable: 1 })
    );

    expect(current.runConverter).not.toHaveBeenCalled();
    const [after] = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    expect(after.id).toBe(before.id);
    expect(await chunksFor(after.id)).toHaveLength(0);
  });
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

// ── a source swapped after discovery is never read ────────────────────────
//
// Discovery skips symlinks, but every read after it used to follow one. So the
// author of one mounted folder could replace `report.pdf`, between the walk and
// the read, with a link to a file only ANOTHER team's agent may see — and that
// file was indexed under `report.pdf`, quotable by the first team's agent. The
// first report (processed 0) arrives after discovery and before any read, which
// is exactly where an attacker's swap lands.

const SECRET = "TOP SECRET merger terms for another team";

/** A folder outside the indexed root, holding what must never be indexed. */
function secretFile(name: string): string {
  const dir = join(tmpRoot, "..", `${basename(tmpRoot)}-other-team`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, SECRET);
  return path;
}

afterEach(() => {
  rmSync(join(tmpRoot, "..", `${basename(tmpRoot)}-other-team`), { recursive: true, force: true });
});

/** Runs `swap` once, after discovery and before the first file is read. */
function afterDiscovery(swap: () => void) {
  let done = false;
  return (progress: IngestProgress) => {
    if (done || progress.processed !== 0) return;
    done = true;
    swap();
  };
}

/** Every reader the ingest can hand a source to, each recording the bytes it was given. */
function recordingDeps() {
  const seen: string[] = [];
  const read = (path: string) => seen.push(readFileSync(path, "utf8"));
  const deps: IngestDeps = {
    embed: async (texts) => texts.map(() => Array(768).fill(0.02)),
    extractPdf: vi.fn(async (path: string) => {
      if (!path.startsWith("/artifacts/")) read(path);
      return [{ page: 1, text: PAGE_1_TEXT }];
    }),
    extractXlsx: vi.fn(async (path: string) => {
      read(path);
      return {
        chunks: [{ text: SHEET_ROWS_TEXT, sheet: "Suppliers", startRow: 2, endRow: 3 }],
        sheets: ["Suppliers"],
        hiddenSheets: [],
        hiddenRows: 0,
      };
    }),
    convertOffice: vi.fn(async (sources: readonly { absPath: string }[]) =>
      sources.map((source) => {
        read(source.absPath);
        return {
          sourcePath: source.absPath,
          status: "converted" as const,
          artifactPath: "/artifacts/converted.pdf",
        };
      })
    ),
    ocrModel: null,
    stagingDir,
  };
  return { deps, seen };
}

it.each(["report.pdf", "suppliers.xlsx", "report.docx"])(
  "never reads %s once it is swapped for a link after discovery",
  async (name) => {
    const source = join(tmpRoot, name);
    writeFileSync(source, "harmless report");
    const secret = secretFile(name);
    const { deps, seen } = recordingDeps();
    const refused: Array<[string, string]> = [];

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: IngestResult;
    try {
      result = await ingestPaths(ORG_ID, [tmpRoot], deps, {
        onProgress: afterDiscovery(() => {
          rmSync(source);
          symlinkSync(secret, source);
        }),
        onRefusedFile: (path, refusal) => refused.push([path, refusal]),
      });
    } finally {
      consoleError.mockRestore();
    }

    // Booked like any file the run could not read, and reported as a refusal.
    expect(result).toEqual(counts({ failed: 1 }));
    expect(refused).toEqual([[source, "link"]]);
    // The point: no reader was ever handed the other team's bytes.
    expect(seen.join("\n")).not.toContain(SECRET);
    expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(
      0
    );
  }
);

it("reads a file an editor saved during the run — a new file renamed over the old one", async () => {
  // A new inode at the same place, inside the same folder. That is an ordinary
  // save, not a swap: refusing it would leave the document unindexed until a
  // later run, and on a filesystem without stable inode numbers (cifs
  // `noserverino`, sshfs without `use_ino`) on every run.
  const source = join(tmpRoot, "report.pdf");
  writeFileSync(source, "first draft");
  const { deps, seen } = recordingDeps();
  const refused: string[] = [];

  const result = await ingestPaths(ORG_ID, [tmpRoot], deps, {
    onProgress: afterDiscovery(() => {
      writeFileSync(join(tmpRoot, ".report.pdf.tmp"), "saved again");
      renameSync(join(tmpRoot, ".report.pdf.tmp"), source);
    }),
    onRefusedFile: (path) => refused.push(path),
  });

  expect(result).toEqual(counts({ indexed: 1 }));
  expect(refused).toEqual([]);
  expect(seen).toEqual(["saved again"]);
});

it("keeps the version it already indexed when the file is swapped for a link", async () => {
  // A refusal is a failed read, not a deletion: the removal pass only drops
  // what discovery no longer finds, and the old chunks stay searchable.
  const source = join(tmpRoot, "report.pdf");
  writeFileSync(source, "harmless report");
  const { deps, seen } = recordingDeps();
  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  const before = await onlyDocument();
  const chunksBefore = await chunksFor(before.id);

  const secret = secretFile("report.pdf");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const second = await ingestPaths(ORG_ID, [tmpRoot], deps, {
      onProgress: afterDiscovery(() => {
        rmSync(source);
        symlinkSync(secret, source);
      }),
    });
    expect(second).toEqual(counts({ failed: 1 }));
  } finally {
    consoleError.mockRestore();
  }

  const after = await onlyDocument();
  expect(after.id).toBe(before.id);
  expect(after.contentHash).toBe(before.contentHash);
  expect((await chunksFor(after.id)).map((c) => c.id).sort()).toEqual(
    chunksBefore.map((c) => c.id).sort()
  );
  expect(seen.join("\n")).not.toContain(SECRET);
});

it("never reads through a parent folder swapped for a link after discovery", async () => {
  // O_NOFOLLOW guards the last path component only. Swapping the FOLDER for a
  // link to another team's folder holding a file of the same name is the
  // variant it cannot see.
  const sub = join(tmpRoot, "projects");
  mkdirSync(sub);
  writeFileSync(join(sub, "report.pdf"), "harmless report");
  const secretDir = dirname(secretFile("report.pdf"));
  const { deps, seen } = recordingDeps();
  const refused: string[] = [];

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let result: IngestResult;
  try {
    result = await ingestPaths(ORG_ID, [tmpRoot], deps, {
      onProgress: afterDiscovery(() => {
        renameSync(sub, join(tmpRoot, ".projects-aside"));
        symlinkSync(secretDir, sub);
      }),
      onRefusedFile: (path) => refused.push(path),
    });
  } finally {
    consoleError.mockRestore();
  }

  expect(result).toEqual(counts({ failed: 1 }));
  expect(refused).toEqual([join(sub, "report.pdf")]);
  expect(seen.join("\n")).not.toContain(SECRET);
});

it("never hands a swapped Office document to the converter, not even in another document's batch", async () => {
  // The converter is handed a SLICE of the queue — documents the ingest has not
  // read itself yet. Those are read through the same checks before they reach
  // LibreOffice, so a swap behind a later queue entry is refused there too.
  for (let i = 0; i < 3; i++) writeFileSync(join(tmpRoot, `doc-${i}.docx`), `bytes-${i}`);
  const secret = secretFile("doc-2.docx");
  const { deps, seen } = recordingDeps();

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let result: IngestResult;
  try {
    result = await ingestPaths(ORG_ID, [tmpRoot], deps, {
      onProgress: afterDiscovery(() => {
        rmSync(join(tmpRoot, "doc-2.docx"));
        symlinkSync(secret, join(tmpRoot, "doc-2.docx"));
      }),
    });
  } finally {
    consoleError.mockRestore();
  }

  expect(result).toEqual(counts({ indexed: 2, failed: 1 }));
  expect(seen.join("\n")).not.toContain(SECRET);
  expect(seen.sort()).toEqual(["bytes-0", "bytes-1"]);
});

it("hands every reader a private copy of the source, never a path on the share", async () => {
  // Readers that only take a path (pdfjs, exceljs, LibreOffice) open it
  // themselves and would follow whatever sits there by then. A copy made from
  // the verified descriptor is a path no author of the share controls.
  const nested = join(tmpRoot, "Abteilung", "2026");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "handbook.pdf"), "pdf bytes");
  writeFileSync(join(nested, "suppliers.xlsx"), "xlsx bytes");
  writeFileSync(join(nested, "Angebot.docx"), "docx bytes");
  const { deps, seen } = recordingDeps();

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 3 }));

  const handed = [
    ...(deps.extractXlsx as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string),
    ...(deps.convertOffice as ReturnType<typeof vi.fn>).mock.calls.flatMap((c) =>
      (c[0] as { absPath: string }[]).map((s) => s.absPath)
    ),
    ...(deps.extractPdf as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((p) => !p.startsWith("/artifacts/")),
  ];
  expect(handed).toHaveLength(3);
  for (const path of handed) expect(path.startsWith(tmpRoot)).toBe(false);
  // Under the source's own name, so extension dispatch and log lines still read right.
  expect(handed.map((p) => basename(p)).sort()).toEqual([
    "Angebot.docx",
    "handbook.pdf",
    "suppliers.xlsx",
  ]);
  expect(seen.sort()).toEqual(["docx bytes", "pdf bytes", "xlsx bytes"]);
  // The rows still carry the ORIGINAL path: identity is the document on the share.
  const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  expect(docs.map((d) => d.sourcePath).sort()).toEqual(
    ["Angebot.docx", "handbook.pdf", "suppliers.xlsx"].map((n) => join(nested, n))
  );
  // And the copies are gone once the run is over.
  for (const path of handed) expect(existsSync(path)).toBe(false);
});

it("indexes through a root that is itself a link, as before", async () => {
  // An admin may grant a path that is a link to the real mount. Only links
  // BELOW the root are refused; the root is the admin's own configuration.
  writeFileSync(join(tmpRoot, "handbook.pdf"), "pdf bytes");
  const linkedRoot = `${tmpRoot}-link`;
  symlinkSync(tmpRoot, linkedRoot);
  try {
    const { deps } = recordingDeps();
    expect(await ingestDirectory(ORG_ID, linkedRoot, deps)).toEqual(counts({ indexed: 1 }));
    expect((await onlyDocument()).sourcePath).toBe(join(linkedRoot, "handbook.pdf"));
  } finally {
    rmSync(linkedRoot, { force: true });
  }
});

it("does not index a link that was already in the folder when it was listed", async () => {
  writeFileSync(join(tmpRoot, "handbook.pdf"), "pdf bytes");
  symlinkSync(secretFile("board.pdf"), join(tmpRoot, "board.pdf"));
  const { deps, seen } = recordingDeps();

  expect(await ingestDirectory(ORG_ID, tmpRoot, deps)).toEqual(counts({ indexed: 1 }));
  expect(seen).toEqual(["pdf bytes"]);
});

describe("files whose type the indexer cannot read (#1267)", () => {
  async function unsupportedUnder(...allowedPaths: string[]): Promise<UnsupportedFile[]> {
    const out: UnsupportedFile[] = [];
    for await (const page of listUnsupportedFiles(ORG_ID, allowedPaths)) out.push(...page);
    return out;
  }

  // The staging case the issue was filed from: 13 files, 11 indexed, and the
  // other two nowhere. They must be counted and named, with their type.
  it("counts and records them with path and type, beside the documents it indexes", async () => {
    writeFileSync(join(tmpRoot, "handbook.pdf"), "fake-pdf-bytes");
    mkdirSync(join(tmpRoot, "scans"));
    writeFileSync(join(tmpRoot, "scans", "Nameplate.TIF"), "tiff");
    writeFileSync(join(tmpRoot, "Budget 2019.xls"), "biff");
    writeFileSync(join(tmpRoot, "README"), "no extension");

    const result = await ingestDirectory(ORG_ID, tmpRoot, fakeDeps().deps);

    expect(result).toEqual(counts({ indexed: 1, unsupported: 3 }));
    expect(await unsupportedUnder(tmpRoot)).toEqual(
      [
        { sourcePath: join(tmpRoot, "Budget 2019.xls"), type: ".xls" },
        { sourcePath: join(tmpRoot, "README"), type: "" },
        { sourcePath: join(tmpRoot, "scans", "Nameplate.TIF"), type: ".tif" },
      ].sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : 1))
    );
  });

  // Never documents: listing them would bury the scans in noise. Same for
  // anything under a hidden or OS-reserved folder.
  it("leaves out hidden files, OS artifacts and temp files", async () => {
    writeFileSync(join(tmpRoot, ".DS_Store"), "x");
    writeFileSync(join(tmpRoot, "Thumbs.db"), "x");
    writeFileSync(join(tmpRoot, "~$Report.docx"), "x");
    writeFileSync(join(tmpRoot, "draft.tmp"), "x");
    mkdirSync(join(tmpRoot, ".git"));
    writeFileSync(join(tmpRoot, ".git", "config"), "x");
    mkdirSync(join(tmpRoot, "$RECYCLE.BIN"));
    writeFileSync(join(tmpRoot, "$RECYCLE.BIN", "deleted.tif"), "x");

    const result = await ingestDirectory(ORG_ID, tmpRoot, fakeDeps().deps);

    expect(result).toEqual(counts());
    expect(await unsupportedUnder(tmpRoot)).toEqual([]);
  });

  // The admin's progress view reads counts off the progress stream, and a run
  // that dies halfway is read back the same way: the number is known from
  // discovery on, not only from a return value a throw would skip.
  it("reports the count from the first progress report on", async () => {
    writeFileSync(join(tmpRoot, "handbook.pdf"), "fake-pdf-bytes");
    writeFileSync(join(tmpRoot, "notes.txt"), "plain text");
    const reports: IngestProgress[] = [];

    await ingestDirectory(ORG_ID, tmpRoot, fakeDeps().deps, {
      onProgress: (p) => void reports.push(p),
    });

    expect(reports[0].counts.unsupported).toBe(1);
  });

  it("drops a file from the list once it is gone or converted", async () => {
    const xls = join(tmpRoot, "Budget.xls");
    writeFileSync(xls, "biff");
    await ingestDirectory(ORG_ID, tmpRoot, fakeDeps().deps);

    rmSync(xls);
    writeFileSync(join(tmpRoot, "Budget.xlsx"), "converted");
    const { deps } = fakeDeps();
    await ingestDirectory(ORG_ID, tmpRoot, deps);

    expect(await unsupportedUnder(tmpRoot)).toEqual([]);
  });

  it("counts a granted single file of an unsupported type", async () => {
    const tif = join(tmpRoot, "Plate.tif");
    writeFileSync(tif, "tiff");

    const result = await ingestPaths(ORG_ID, [tif], fakeDeps().deps);

    expect(result).toEqual(counts({ unsupported: 1 }));
    expect(await unsupportedUnder(tif)).toEqual([{ sourcePath: tif, type: ".tif" }]);
  });

  it("counts a file under two overlapping roots once", async () => {
    mkdirSync(join(tmpRoot, "hr"));
    writeFileSync(join(tmpRoot, "hr", "Plate.tif"), "tiff");

    const result = await ingestPaths(ORG_ID, [tmpRoot, join(tmpRoot, "hr")], fakeDeps().deps);

    expect(result.unsupported).toBe(1);
  });

  // A share that failed to mount is an empty folder. Its documents are kept
  // (keepEmptiedFolders), and so is the list of what it holds that we cannot
  // read: an outage must not read as "the scans are gone".
  it("keeps the list of a folder that came up empty while its documents were kept", async () => {
    const share = join(tmpRoot, "share");
    mkdirSync(share);
    writeFileSync(join(share, "contract.pdf"), "fake-pdf-bytes");
    writeFileSync(join(share, "Plate.tif"), "tiff");
    writeFileSync(join(tmpRoot, "other.pdf"), "fake-pdf-bytes-2");
    await ingestDirectory(ORG_ID, tmpRoot, fakeDeps().deps, { keepEmptiedFolders: true });

    rmSync(join(share, "contract.pdf"));
    rmSync(join(share, "Plate.tif"));
    await ingestDirectory(ORG_ID, tmpRoot, fakeDeps().deps, { keepEmptiedFolders: true });

    expect(await unsupportedUnder(tmpRoot)).toEqual([
      { sourcePath: join(share, "Plate.tif"), type: ".tif" },
    ]);
  });

  it("keeps the list of a granted folder it could not read", async () => {
    const share = join(tmpRoot, "share");
    mkdirSync(share);
    writeFileSync(join(share, "Plate.tif"), "tiff");
    await ingestDirectory(ORG_ID, share, fakeDeps().deps);

    rmSync(share, { recursive: true });
    await ingestDirectory(ORG_ID, share, fakeDeps().deps);

    expect(await unsupportedUnder(share)).toEqual([
      { sourcePath: join(share, "Plate.tif"), type: ".tif" },
    ]);
  });

  // Written at the end, like the removal pass: half a walk is not the share.
  it("leaves the previous list in place when a run dies halfway", async () => {
    writeFileSync(join(tmpRoot, "Plate.tif"), "tiff");
    writeFileSync(join(tmpRoot, "handbook.pdf"), "fake-pdf-bytes");
    await ingestDirectory(ORG_ID, tmpRoot, fakeDeps().deps);

    writeFileSync(join(tmpRoot, "Budget.xls"), "biff");
    writeFileSync(join(tmpRoot, "handbook.pdf"), "changed-bytes");
    const { deps } = fakeDeps();
    deps.embed = async () => {
      throw new EmbedderUnavailableError("embedder down");
    };
    await expect(ingestDirectory(ORG_ID, tmpRoot, deps)).rejects.toThrow("embedder down");

    expect((await unsupportedUnder(tmpRoot)).map((f) => f.sourcePath)).toEqual([
      join(tmpRoot, "Plate.tif"),
    ]);
  });
});

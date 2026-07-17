/**
 * Knowledge-base ingest pipeline (server-side): discover -> extract -> chunk
 * -> embed -> upsert.
 *
 * Idempotent on (orgId, sourcePath, contentHash):
 *   - unchanged file (same content hash) with chunks already present -> skip.
 *   - unchanged file whose document row has zero chunks (partial/legacy
 *     state — see the doc comment on the zero-chunk branch below) -> rebuild
 *     chunks in place.
 *   - changed file (different content hash) -> replace: delete the old
 *     document row (cascades to its chunks) and re-ingest.
 *   - a previously-indexed file that's gone from disk -> delete its document
 *     row (cascades to its chunks).
 *
 * The result counts what an operator needs to trust the corpus, so "processed"
 * is never conflated with "findable": a file that parses but yields no text
 * (image-only scan) counts as `unsearchable`, not `indexed`, and a file that
 * cannot be read or parsed counts as `failed` without taking the rest of the
 * run down with it.
 *
 * The embedder and PDF extractor are dependency-injected: production wires
 * `embedTexts` (./embeddings.ts) and a pdfjs-based extractor
 * (./pdf-extract.ts); tests inject deterministic fakes so the integration
 * suite stays hermetic (real Postgres, no Ollama, no real PDF parsing).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";

import { and, count, eq } from "drizzle-orm";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  isAllowedExtension,
  isDenylistedDirName,
  isDenylistedFileName,
  isHiddenSegment,
} from "./exclude-globs";
import { chunkPages } from "./chunk";
import { detectLang } from "./lid";

export interface IngestPage {
  page: number;
  text: string;
}

export interface IngestDeps {
  /** Batch-embeds chunk texts into dense vectors (bge-m3, 1024-dim). Prod: `(t) => embedTexts(t, embedCfg)`. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Extracts per-page text from a PDF at an absolute path. Prod: pdfjs-based (./pdf-extract.ts). */
  extractPdf: (absPath: string) => Promise<IngestPage[]>;
}

export interface IngestOptions {
  /** Overrides the default extension allowlist (`[".pdf"]` for the MVP). */
  allowedExtensions?: readonly string[];
}

export interface IngestResult {
  /** Documents newly indexed, replaced due to a content change, or recovered from a zero-chunk state — and searchable afterwards (at least one chunk). */
  indexed: number;
  /** Documents left untouched: unchanged content hash, chunks already present. */
  skipped: number;
  /** Documents deleted because their source file is no longer on disk. */
  removed: number;
  /**
   * Files that parsed without error but yielded no chunks, so they are indexed
   * yet can never be retrieved — an image-only scan with no text layer is the
   * normal cause. Counted apart from `indexed` because the counts exist to
   * answer "is the corpus findable?", and folding these into `indexed` reports
   * a complete corpus while a slice of it silently answers nothing.
   */
  unsearchable: number;
  /** Files skipped because reading or extracting THIS file threw (unreadable, corrupt). The run continues; see the per-file boundary in ingestDirectory. */
  failed: number;
}

/** Applies the per-file eligibility rules (skip-hidden + A/B denylist + extension allowlist) to a basename. */
function isEligibleFile(name: string, allowedExtensions: readonly string[]): boolean {
  if (isHiddenSegment(name)) return false;
  if (isDenylistedFileName(name)) return false;
  return isAllowedExtension(name, allowedExtensions);
}

/** Recursively lists ingest-eligible files under a DIRECTORY, applying the allowlist + skip-hidden + A/B denylist (exclude-globs.ts). */
async function walkDir(dir: string, allowedExtensions: readonly string[]): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (isHiddenSegment(entry.name)) continue;
    const absPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isDenylistedDirName(entry.name)) continue;
      files.push(...(await walkDir(absPath, allowedExtensions)));
    } else if (entry.isFile()) {
      if (isEligibleFile(entry.name, allowedExtensions)) files.push(absPath);
    }
  }

  return files;
}

/**
 * Lists ingest-eligible files for a root that may be a directory OR a single
 * file. An `allowed_paths` grant (pinchy-files) can point at either; a naive
 * `readdir(root)` throws ENOTDIR on a file root (surfacing as an opaque 500
 * from the reindex route), so we stat the root first: a directory is walked
 * recursively, a file is treated as a one-file corpus (subject to the same
 * eligibility rules), and a missing/other root yields nothing rather than
 * throwing.
 */
async function discoverFiles(
  rootDir: string,
  allowedExtensions: readonly string[]
): Promise<string[]> {
  let rootStat;
  try {
    rootStat = await stat(rootDir);
  } catch {
    // Missing or unreadable root: nothing to ingest (and nothing to remove —
    // see the removal pass, which is scoped to this same root).
    return [];
  }

  if (rootStat.isFile()) {
    return isEligibleFile(basename(rootDir), allowedExtensions) ? [rootDir] : [];
  }
  if (!rootStat.isDirectory()) return [];

  return walkDir(rootDir, allowedExtensions);
}

/**
 * Is `sourcePath` within this ingest root? Handles both root shapes with one
 * predicate: an exact match (file root, or the root's own path) OR a
 * separator-bounded descendant (directory root — "/data/foo" never matches
 * "/data/foobar/x.pdf"). Used to scope the removal pass so ingesting one root
 * never deletes documents indexed from a different root for the same org.
 */
function isUnderRoot(sourcePath: string, rootDir: string): boolean {
  if (sourcePath === rootDir) return true;
  const rootPrefix = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  return sourcePath.startsWith(rootPrefix);
}

/**
 * Chunks `pages`, embeds every chunk, and inserts the resulting kb_chunks rows
 * for `documentId`. Returns the number of chunks written — zero means the
 * document is indexed but unsearchable (e.g. an image-only scan whose text
 * layer is empty), which callers must report as such rather than as a
 * successful index.
 */
async function writeChunks(
  documentId: string,
  orgId: string,
  sourcePath: string,
  pages: IngestPage[],
  deps: IngestDeps
): Promise<number> {
  const chunks = chunkPages(pages);
  if (chunks.length === 0) return 0;

  const vectors = await deps.embed(chunks.map((chunk) => chunk.text));

  await db.insert(kbChunks).values(
    chunks.map((chunk, i) => ({
      documentId,
      orgId,
      sourcePath,
      chunkText: chunk.text,
      page: chunk.page,
      lang: detectLang(chunk.text),
      embedding: vectors[i],
    }))
  );

  return chunks.length;
}

/**
 * A file-level ingest failure: THIS file could not be read or parsed (corrupt
 * PDF, permission denied, vanished between the walk and the read). Distinct
 * from the errors ingestDirectory deliberately lets escape — embedding and DB
 * failures are systemic, and reporting an Ollama outage as "193 corrupt files"
 * would bury the one fact an operator needs.
 */
class FileIngestError extends Error {
  constructor(
    readonly sourcePath: string,
    cause: unknown
  ) {
    super(`Ingest failed for ${sourcePath}`, { cause });
    this.name = "FileIngestError";
  }
}

/** Runs a file-scoped step, tagging anything it throws as a FileIngestError so the per-file boundary in ingestDirectory can catch exactly those. */
async function fileStep<T>(sourcePath: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw new FileIngestError(sourcePath, err);
  }
}

/** How one file ended up, mapping 1:1 onto the IngestResult counters of the same name. */
type FileOutcome = "indexed" | "skipped" | "unsearchable";

/**
 * Ingests one file: hash it, decide skip/recover/replace/insert, and write its
 * chunks. Reading and PDF extraction are wrapped in fileStep() so a failure
 * THIS file owns surfaces as a FileIngestError; embedding and DB calls are
 * deliberately left bare so a systemic outage aborts the whole run.
 */
async function ingestFile(orgId: string, absPath: string, deps: IngestDeps): Promise<FileOutcome> {
  const { buffer, fileStat } = await fileStep(absPath, async () => ({
    buffer: await readFile(absPath),
    fileStat: await stat(absPath),
  }));
  const contentHash = createHash("sha256").update(buffer).digest("hex");

  const [existing] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, orgId), eq(kbDocuments.sourcePath, absPath)))
    .limit(1);

  if (existing && existing.contentHash === contentHash) {
    const [{ value: chunkCount }] = await db
      .select({ value: count() })
      .from(kbChunks)
      .where(eq(kbChunks.documentId, existing.id));

    if (chunkCount > 0) return "skipped";

    // Robustness case: a document row survives with zero chunks (e.g. a
    // prior ingest crashed after the document insert but before chunk
    // writes, or an operator hand-deleted kb_chunks rows). The content
    // hash still matches the file on disk, so a naive "hash matches ->
    // skip" would leave this document permanently unsearchable while
    // silently reporting success. We recover instead: rebuild chunks for
    // the existing document (same id, no duplicate row).
    //
    // A file with no text at all lands here too, on every run, and rebuilds
    // to zero chunks again — the write result, not the branch, is what tells
    // the two apart.
    const pages = await fileStep(absPath, () => deps.extractPdf(absPath));
    const written = await writeChunks(existing.id, orgId, absPath, pages, deps);
    return written > 0 ? "indexed" : "unsearchable";
  }

  // Extract BEFORE deleting the old version: a file that changed into
  // something unparseable throws here and stays a `failed` update, with the
  // last good document and its chunks still searchable. Deleting first would
  // turn that same failure into silent data loss on a success response.
  const pages = await fileStep(absPath, () => deps.extractPdf(absPath));

  if (existing) {
    // Content changed since the last ingest: replace wholesale. Deleting
    // the document row cascades to its (now stale) chunks via the
    // kb_chunks.document_id FK.
    await db.delete(kbDocuments).where(eq(kbDocuments.id, existing.id));
  }

  const wholeDocText = pages.map((p) => p.text).join("\n");

  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId,
      contentHash,
      sourcePath: absPath,
      pageCount: pages.length,
      mtime: fileStat.mtime,
      lang: detectLang(wholeDocText),
    })
    .returning();

  const written = await writeChunks(doc.id, orgId, absPath, pages, deps);
  return written > 0 ? "indexed" : "unsearchable";
}

export async function ingestDirectory(
  orgId: string,
  rootDir: string,
  deps: IngestDeps,
  opts: IngestOptions = {}
): Promise<IngestResult> {
  const allowedExtensions = opts.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  const discovered = await discoverFiles(rootDir, allowedExtensions);

  const tally: Record<FileOutcome, number> = { indexed: 0, skipped: 0, unsearchable: 0 };
  let failed = 0;

  for (const absPath of discovered) {
    try {
      tally[await ingestFile(orgId, absPath, deps)]++;
    } catch (err) {
      // One unreadable or corrupt file is a normal property of a real corpus,
      // so it costs itself and nothing else: without this boundary a single
      // bad PDF aborts the reindex for every other file, and under a retrying
      // job runner it would fail identically forever. Systemic errors
      // (embedding outage, DB gone) are NOT FileIngestErrors and still escape
      // — see ingestFile.
      if (!(err instanceof FileIngestError)) throw err;
      // The admin-facing counts must not name paths (audit PII rule), so this
      // server log is the only place that says WHICH file failed and why.
      console.error(`[kb-ingest] ${err.message}`, err.cause);
      failed++;
    }
  }

  // Removal pass: any previously-indexed document under this root whose
  // source file is no longer among the discovered files. Scoped to rootDir
  // via isUnderRoot (separator-bounded for a directory root, exact-match for
  // a file root) so ingesting one root never touches documents indexed from a
  // different root for the same org.
  //
  // A file that vanishes between the walk and the read is still in
  // `discovered`, so this pass leaves its document row alone for one run (it
  // counts as `failed` above); the next run no longer discovers it and
  // removes it here. Erring toward keeping the row beats deleting on a
  // transient read failure.
  const discoveredSet = new Set(discovered);
  const existingForOrg = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, orgId));

  let removed = 0;
  for (const doc of existingForOrg) {
    if (!isUnderRoot(doc.sourcePath, rootDir)) continue;
    if (discoveredSet.has(doc.sourcePath)) continue;
    await db.delete(kbDocuments).where(eq(kbDocuments.id, doc.id));
    removed++;
  }

  return { ...tally, removed, failed };
}

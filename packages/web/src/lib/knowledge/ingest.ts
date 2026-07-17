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
 * ingestPaths() runs many roots as ONE job: discovery walks every root before
 * the first extract, so the document total is known upfront and a file
 * reachable from two overlapping roots counts once. ingestDirectory() is the
 * single-root wrapper over it.
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
import type { IngestPage, IngestResult } from "./types";

// IngestPage/IngestResult live in ./types (a runtime-free module) because
// db/schema.ts persists IngestResult as a jsonb column and cannot import from
// this file — it is what this file imports. Re-exported here so callers can
// keep treating the ingest module as the contract's home.
export type { IngestPage, IngestResult } from "./types";

export interface IngestDeps {
  /** Batch-embeds chunk texts into dense vectors (bge-m3, 1024-dim). Prod: `(t) => embedTexts(t, embedCfg)`. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Extracts per-page text from a PDF at an absolute path. Prod: pdfjs-based (./pdf-extract.ts). */
  extractPdf: (absPath: string) => Promise<IngestPage[]>;
}

export interface IngestOptions {
  /** Overrides the default extension allowlist (`[".pdf"]` for the MVP). */
  allowedExtensions?: readonly string[];
  /**
   * Called once with the discovery total before the first file is touched, then
   * after every file. `total` never changes during a run.
   *
   * Deliberately called per file rather than on a timer: ingest reports what
   * happened, and a caller that wants fewer writes (the index worker persists
   * each report to Postgres) throttles in its own callback, where the cost of a
   * write is known.
   */
  onProgress?: (progress: IngestProgress) => void | Promise<void>;
}

export interface IngestProgress {
  /** Files whose ingest is behind us — including the ones that failed. Progress measures how much of the corpus is done, not how much of it succeeded. */
  processed: number;
  /** Files discovered across every root, deduplicated. Known before the first file, so a bar built on it never runs backwards. */
  total: number;
  /**
   * The tally so far.
   *
   * Reported alongside progress rather than only returned, because the return
   * value is exactly what a systemic failure destroys: a run that dies on file
   * 1501 of 2000 really did index 1500 documents, and the only way a caller can
   * know that is if the tally reached it before the throw. `removed` stays 0
   * until the removal pass runs at the very end.
   */
  counts: IngestResult;
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
 * file, or returns null if the root could not be read at all.
 *
 * An `allowed_paths` grant (pinchy-files) can point at either shape; a naive
 * `readdir(root)` throws ENOTDIR on a file root (surfacing as an opaque 500
 * from the reindex route), so we stat the root first: a directory is walked
 * recursively, and a file is treated as a one-file corpus subject to the same
 * eligibility rules.
 *
 * null and [] are DIFFERENT answers and the removal pass depends on it. []
 * means "I looked, there is nothing" — documents under this root are genuinely
 * gone and should be dropped. null means "I could not look", which is what an
 * unmounted volume looks like, and is indistinguishable from an emptied folder
 * from the outside. Collapsing the two would let a bind mount that is not
 * ready yet — a live race, since the index worker starts seconds after boot —
 * delete an entire corpus and report success.
 */
async function discoverFiles(
  rootDir: string,
  allowedExtensions: readonly string[]
): Promise<string[] | null> {
  let rootStat;
  try {
    rootStat = await stat(rootDir);
  } catch {
    return null;
  }

  if (rootStat.isFile()) {
    return isEligibleFile(basename(rootDir), allowedExtensions) ? [rootDir] : [];
  }
  // A socket, device, or dangling symlink: readable, and holds no documents.
  if (!rootStat.isDirectory()) return [];

  try {
    return await walkDir(rootDir, allowedExtensions);
  } catch {
    // The root vanished or turned unreadable mid-walk. Same reasoning as
    // above: a partial listing must not be mistaken for the whole truth.
    return null;
  }
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

/**
 * Deletes the documents previously indexed under `rootDir` whose source file is
 * no longer on disk, and returns how many. Scoped to rootDir via isUnderRoot
 * (separator-bounded for a directory root, exact-match for a file root) so
 * ingesting one root never touches documents indexed from a different root for
 * the same org.
 *
 * `discovered` is that root's OWN listing, not the run's deduplicated queue: two
 * overlapping roots (an admin may grant both /data and /data/hr) each see the
 * shared file in their own set, so neither pass deletes what the other covers.
 *
 * A file that vanishes between the walk and the read is still in `discovered`,
 * so this pass leaves its document row alone for one run (it counts as `failed`
 * instead); the next run no longer discovers it and removes it here. Erring
 * toward keeping the row beats deleting on a transient read failure.
 */
async function removeVanishedDocuments(
  orgId: string,
  rootDir: string,
  discovered: ReadonlySet<string>
): Promise<number> {
  const existingForOrg = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, orgId));

  let removed = 0;
  for (const doc of existingForOrg) {
    if (!isUnderRoot(doc.sourcePath, rootDir)) continue;
    if (discovered.has(doc.sourcePath)) continue;
    await db.delete(kbDocuments).where(eq(kbDocuments.id, doc.id));
    removed++;
  }
  return removed;
}

/**
 * Ingests every root in one run, reporting progress against a single total.
 *
 * Discovery walks all roots FIRST, for two reasons: the total has to be known
 * before the first file so a progress bar can't run backwards, and a file
 * reachable from two overlapping roots (an admin may grant both `/data` and
 * `/data/hr`) is one unit of work — ingesting it twice would inflate `skipped`
 * and stall the bar one short of its total.
 *
 * The removal pass stays per-root and keeps that root's OWN discovered set, so
 * overlap never lets one root's pass delete a document the other root still
 * covers.
 */
export async function ingestPaths(
  orgId: string,
  rootDirs: readonly string[],
  deps: IngestDeps,
  opts: IngestOptions = {}
): Promise<IngestResult> {
  const allowedExtensions = opts.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;

  // A root we could not read is dropped from the run entirely: it contributes
  // no files to ingest AND no removal pass, because we have no evidence about
  // what is under it. See discoverFiles for why that distinction is not
  // pedantry.
  const perRoot: Array<{ rootDir: string; discovered: Set<string> }> = [];
  for (const rootDir of rootDirs) {
    const discovered = await discoverFiles(rootDir, allowedExtensions);
    if (discovered === null) continue;
    perRoot.push({ rootDir, discovered: new Set(discovered) });
  }

  // Deduplicated across roots, but ordered so each file is ingested while its
  // first root is being processed — the order only matters for readability of
  // the progress stream, not for correctness.
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const { discovered } of perRoot) {
    for (const absPath of discovered) {
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      queue.push(absPath);
    }
  }

  const tally: Record<FileOutcome, number> = { indexed: 0, skipped: 0, unsearchable: 0 };
  let failed = 0;
  let processed = 0;
  let removed = 0;
  const total = queue.length;
  const snapshot = (): IngestResult => ({ ...tally, removed, failed });

  // Reported before any work: "0 of N" is what tells a caller the run started
  // and how big it is. A caller that hears nothing until the first file lands
  // cannot tell a slow run from a dead one.
  await opts.onProgress?.({ processed, total, counts: snapshot() });

  for (const absPath of queue) {
    try {
      tally[await ingestFile(orgId, absPath, deps)]++;
    } catch (err) {
      // One unreadable or corrupt file is a normal property of a real corpus,
      // so it costs itself and nothing else: without this boundary a single
      // bad PDF aborts the reindex for every other file, and under a retrying
      // job runner it would fail identically forever. Systemic errors
      // (embedding outage, DB gone) are NOT FileIngestErrors and still escape
      // — see ingestFile. The tally reported so far is the caller's last
      // honest word on what the run achieved before that happened.
      if (!(err instanceof FileIngestError)) throw err;
      // The admin-facing counts must not name paths (audit PII rule), so this
      // server log is the only place that says WHICH file failed and why.
      console.error(`[kb-ingest] ${err.message}`, err.cause);
      failed++;
    }
    processed++;
    await opts.onProgress?.({ processed, total, counts: snapshot() });
  }

  for (const { rootDir, discovered } of perRoot) {
    removed += await removeVanishedDocuments(orgId, rootDir, discovered);
  }

  return snapshot();
}

/** Ingests a single root. Thin wrapper over ingestPaths — kept because most callers and tests deal in one directory at a time. */
export async function ingestDirectory(
  orgId: string,
  rootDir: string,
  deps: IngestDeps,
  opts: IngestOptions = {}
): Promise<IngestResult> {
  return ingestPaths(orgId, [rootDir], deps, opts);
}

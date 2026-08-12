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
 * The embedder, the extractors and the Office converter are
 * dependency-injected: production wires `embedTexts` (./embeddings.ts), a
 * pdfjs-based PDF extractor (./pdf-extract.ts), `extractXlsx`
 * (./xlsx-extract.ts) and `convertOfficeFiles` (./office-convert.ts); tests
 * inject deterministic fakes so the integration suite stays hermetic (real
 * Postgres, no Ollama, no LibreOffice, no real PDF or workbook parsing).
 *
 * WHICH extractor runs is decided per file by `extractDocument`, on the
 * extension, and so is the anchor the chunks carry: a page for a PDF, a sheet
 * + row range for a spreadsheet (#940), a slide number for a presentation and
 * a heading path for a Word document (#938). Everything downstream of that
 * dispatch — embedding, writing, idempotency, the removal pass — is
 * format-blind on purpose, which is what kept adding two formats a change to
 * one function rather than to the pipeline.
 *
 * A page-shaped Office document is read through the PDF LibreOffice makes of
 * it, but its IDENTITY stays the original: the row and every chunk carry the
 * source path, because the artifact is not a file the reader has.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";

import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  isAllowedExtension,
  isDenylistedDirName,
  isDenylistedFileName,
  isHiddenSegment,
} from "./exclude-globs";
import { isArchivedPath, statusForPath } from "./archive-paths";
import { chunkPages } from "./chunk";
import { DEFAULT_BATCH_SIZE } from "./embeddings";
import { detectLang } from "./lid";
import { collectHeadingSections, headingLocatorAt } from "./heading-sections";
import { isOfficeFile, isPresentationFile, isSpreadsheetFile, isWordFile } from "./office-formats";
import type { ChunkLocator } from "./locator";
import type { ConversionOutcome, OfficeSource } from "./office-convert";
import type { XlsxExtraction } from "./xlsx-extract";
import type { IngestPage, IngestResult } from "./types";

// IngestPage/IngestResult live in ./types (a runtime-free module) because
// db/schema.ts persists IngestResult as a jsonb column and cannot import from
// this file — it is what this file imports. Re-exported here so callers can
// keep treating the ingest module as the contract's home.
export type { IngestPage, IngestResult } from "./types";

export interface IngestDeps {
  /** Batch-embeds chunk texts into dense vectors (embeddinggemma-300m, 768-dim). Prod: `(t) => embedTexts(t, embedCfg)`. */
  embed: (texts: string[]) => Promise<number[][]>;
  /**
   * Extracts per-page text from a PDF at an absolute path. Prod: pdfjs-based
   * (./pdf-extract.ts).
   *
   * `outline` asks for the heading marks a converted Word document is anchored
   * on (#938). It is a request, not a promise: a document with no heading
   * styles yields none, and its chunks then carry no locator at all.
   */
  extractPdf: (absPath: string, opts?: { outline?: boolean }) => Promise<IngestPage[]>;
  /**
   * Reads a spreadsheet's cells into row-grouped chunks. Prod: `extractXlsx`
   * (./xlsx-extract.ts).
   *
   * Required rather than optional, and the reason is the allowlist: the moment
   * `DEFAULT_ALLOWED_EXTENSIONS` names `.xlsx`, every caller's ingest WILL meet
   * one. An optional extractor would make that a runtime surprise in whichever
   * deployment happens to hold a spreadsheet, instead of a compile error at the
   * one call site that needs updating.
   */
  extractXlsx: (absPath: string) => Promise<XlsxExtraction>;
  /**
   * Converts page-shaped Office documents to PDFs in the artifact store,
   * returning one outcome per source in input order. Prod: `convertOfficeFiles`
   * (./office-convert.ts).
   *
   * Required for the same reason `extractXlsx` is: once
   * `DEFAULT_ALLOWED_EXTENSIONS` names `.doc`, every caller's ingest WILL meet
   * one, and an optional converter would turn that into a runtime surprise in
   * whichever deployment happens to hold a Word file.
   *
   * It takes a BATCH because process startup dominates conversion — 17 real
   * corpus files cost 14.2 s in one process against 25.6 s one-per-file — and
   * the ingest calls it with a slice of its queue rather than one path at a
   * time.
   */
  convertOffice: (sources: readonly OfficeSource[]) => Promise<ConversionOutcome[]>;
}

export interface IngestOptions {
  /**
   * Overrides `DEFAULT_ALLOWED_EXTENSIONS` (exclude-globs.ts).
   *
   * Naming a type here does NOT teach `extractDocument` to read it: the
   * dispatch is by extension, and anything it does not recognise goes to the
   * PDF extractor. Widening this is half a change.
   */
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
   * Bytes of the corpus behind us. Whole files that are done, plus the current
   * file's bytes pro rata to the chunks embedded from it so far — so a document
   * worth a third of the corpus advances progress while it runs instead of
   * freezing it (#907).
   */
  processedBytes: number;
  /**
   * Bytes discovered across every root, deduplicated. Like `total`, known
   * before the first extract — and unlike `total` it is work-proportional,
   * which is what makes a time-to-completion estimate possible at all. A
   * document is NOT a unit of work: one compilation PDF measured 38% of a
   * 193-document corpus's chunks, so a doc-count projection promises "2 min
   * left" at 190/193 and then spends an hour. See lib/knowledge/index-eta.ts.
   *
   * Zero when nothing could be weighed (an empty corpus, or files whose size
   * is zero); consumers must treat that as "no estimate", not as "done".
   */
  totalBytes: number;
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

/**
 * Bytes on disk, or 0 when the size cannot be read.
 *
 * Discovery must not fail over a single file: one that vanished between the
 * readdir and this stat stays in the queue and is counted `failed` at read time,
 * exactly as before. It simply carries no weight, which is the honest thing to
 * do about a size we do not know — unlike dropping the file, which would make
 * the removal pass believe it is gone.
 */
async function fileSize(absPath: string): Promise<number> {
  try {
    return (await stat(absPath)).size;
  } catch {
    return 0;
  }
}

/**
 * Recursively lists ingest-eligible files under a DIRECTORY with their sizes,
 * applying the allowlist + skip-hidden + A/B denylist (exclude-globs.ts).
 *
 * A map, not a list, because discovery is also where the run's byte total comes
 * from: sizes are free here (one stat per eligible file) and unknowable later
 * without a second walk.
 */
async function walkDir(
  dir: string,
  allowedExtensions: readonly string[]
): Promise<Map<string, number>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = new Map<string, number>();

  for (const entry of entries) {
    if (isHiddenSegment(entry.name)) continue;
    const absPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isDenylistedDirName(entry.name)) continue;
      for (const [path, size] of await walkDir(absPath, allowedExtensions)) files.set(path, size);
    } else if (entry.isFile()) {
      if (isEligibleFile(entry.name, allowedExtensions))
        files.set(absPath, await fileSize(absPath));
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
): Promise<Map<string, number> | null> {
  let rootStat;
  try {
    rootStat = await stat(rootDir);
  } catch {
    return null;
  }

  if (rootStat.isFile()) {
    return isEligibleFile(basename(rootDir), allowedExtensions)
      ? new Map([[rootDir, rootStat.size]])
      : new Map();
  }
  // A socket, device, or dangling symlink: readable, and holds no documents.
  if (!rootStat.isDirectory()) return new Map();

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
 * How many chunks are embedded per call, and therefore how often a long
 * document can report on itself.
 *
 * Not a throughput knob: the local embedder (node-llama-cpp) processes one
 * input per call regardless, and the Ollama client already slices at this exact
 * size internally, so this changes the shape of no request. It is purely the
 * granularity at which a document worth a third of the corpus is allowed to say
 * "still moving" — see the progress credit in ingestPaths.
 *
 * Aliased from the embedder's own default rather than spelled as a second 32:
 * a smaller slice here would silently cap a larger configured `batchSize`, and
 * "silently" is the problem — the request would just get smaller, with nothing
 * to notice.
 */
export const EMBED_PROGRESS_BATCH = DEFAULT_BATCH_SIZE;

/** Reports that `embedded` of `total` chunks of the CURRENT document are done. */
export type ChunkProgressCallback = (embedded: number, total: number) => void | Promise<void>;

/**
 * A chunk with the anchor a citation will point at. Every format producer
 * converges here.
 *
 * Null is a real answer, not a missing one: a Word document written without
 * heading styles has no anchor its reader could follow, and #938 chose an
 * omitted locator over one that does not match what they see in Word.
 */
interface LocatedChunk {
  text: string;
  locator: ChunkLocator | null;
}

/**
 * One document, read into the two things the pipeline needs: the chunks to
 * embed, and the facts the `kb_documents` row carries.
 */
interface ExtractedDocument {
  chunks: LocatedChunk[];
  /**
   * Pages, when the format HAS pages — null for a spreadsheet.
   *
   * Not "number of sheets". The column is called `pageCount` and a sheet is
   * not a page; writing one into the other would make the row state something
   * false about the document, which is the same mistake `ChunkLocator` exists
   * to prevent one level down. The column is nullable, so null is a spelling
   * the schema already has for "this format has no pages".
   */
  pageCount: number | null;
  /** Everything the document says, concatenated — read only for language detection. */
  text: string;
}

/**
 * Hands out the converted PDF for an Office source, converting in batches as
 * the queue reaches them.
 *
 * Lazy rather than a pre-pass over the whole corpus, and that is a progress
 * decision: converting everything up front is the same total work but spends
 * it before the first document is reported, so a corpus of Office files would
 * show a bar that does not move for minutes. Batched rather than per-file
 * because process startup dominates (see `IngestDeps.convertOffice`). A run
 * that stops early converts only what it reached.
 *
 * Unchanged documents cost no conversion: the artifact store is keyed on
 * content, so the second run answers from cache (`office-convert.ts`).
 */
function officeArtifacts(
  queue: readonly { absPath: string }[],
  deps: IngestDeps,
  batchSize = OFFICE_CONVERT_BATCH
): (absPath: string) => Promise<ConversionOutcome> {
  const pending = queue.map((file) => file.absPath).filter(isOfficeFile);
  const done = new Map<string, ConversionOutcome>();
  let next = 0;

  return async (absPath: string) => {
    while (!done.has(absPath) && next < pending.length) {
      const batch = pending.slice(next, next + batchSize);
      next += batch.length;
      const outcomes = await deps.convertOffice(batch.map((path) => ({ absPath: path })));
      batch.forEach((path, i) => {
        if (outcomes[i]) done.set(path, outcomes[i]);
      });
    }

    const outcome = done.get(absPath);
    if (outcome) return outcome;
    // The converter returned fewer outcomes than it was given sources, which
    // is a broken contract rather than a statement about this document.
    // Retryable, so it must not be recorded as unreadable.
    return {
      sourcePath: absPath,
      status: "infrastructure",
      reason: "converter returned no outcome for this document",
    };
  };
}

/**
 * Documents per converter process. Matches `office-convert.ts`'s own default —
 * the ingest slices the queue, so a second number here would silently cap the
 * one that was measured.
 */
const OFFICE_CONVERT_BATCH = 20;

/** Resolves the converted PDF for one Office source. */
type ResolveArtifact = (absPath: string) => Promise<ConversionOutcome>;

/**
 * Reads one file into chunks with locators, dispatching on its extension.
 *
 * The dispatch is the whole Wave-2 shape, and every branch anchors on what the
 * format actually has (locator.ts):
 *
 *   PDF           `chunkPages` on the page the text came from
 *   spreadsheet   `extractXlsx`, sheet + row range — `XlsxChunk` IS the
 *                 locator field-for-field, so that half is a spread
 *   presentation  the converted PDF, slide N = page N
 *   Word          the converted PDF's outline, heading path — never a page,
 *                 which the renderer decides and the reader's Word disagrees
 *                 with
 */
async function extractDocument(
  absPath: string,
  deps: IngestDeps,
  resolveArtifact: ResolveArtifact
): Promise<ExtractedDocument> {
  if (isOfficeFile(absPath)) {
    return extractOfficeDocument(absPath, deps, resolveArtifact);
  }

  if (isSpreadsheetFile(absPath)) {
    const extraction = await deps.extractXlsx(absPath);
    return {
      chunks: extraction.chunks.map(({ text, sheet, startRow, endRow }) => ({
        text,
        locator: { kind: "sheet", sheet, startRow, endRow },
      })),
      pageCount: null,
      text: extraction.chunks.map((chunk) => chunk.text).join("\n"),
    };
  }

  const pages = await deps.extractPdf(absPath);
  return {
    chunks: chunkPages(pages).map((chunk) => ({
      text: chunk.text,
      locator: { kind: "page", page: chunk.page },
    })),
    pageCount: pages.length,
    text: pages.map((page) => page.text).join("\n"),
  };
}

/**
 * Reads a page-shaped Office document through the PDF LibreOffice made of it.
 *
 * The identity stays the original: the chunks are written against the source
 * path, and the artifact is never named anywhere a reader can see. A citation
 * that pointed at the artifact would name a file that is not on their share.
 *
 * What the artifact renders is what gets indexed — including text struck
 * through by an unaccepted tracked change, which LibreOffice draws and its
 * text layer therefore carries. That is deliberate: the same artifact is what
 * the citation opens (#939), so indexing anything else would mean the reader
 * is shown a passage the search does not know, or promised one they cannot
 * find. Comments and speaker notes are not rendered at all and so never enter
 * the index — measured against the real binary, not assumed
 * (`office-convert.libreoffice.test.ts`).
 */
async function extractOfficeDocument(
  absPath: string,
  deps: IngestDeps,
  resolveArtifact: ResolveArtifact
): Promise<ExtractedDocument> {
  const outcome = await resolveArtifact(absPath);

  if (outcome.status === "infrastructure") {
    // The converter never got to judge this document (out of memory, timed
    // out, binary missing). Throwing keeps the existing row and its chunks
    // untouched and counts the file `failed`, so a memory squeeze cannot brand
    // a perfectly good document as permanently unreadable (#936).
    throw new Error(`office conversion unavailable: ${outcome.reason ?? "unknown"}`);
  }

  if (outcome.status !== "converted" || !outcome.artifactPath) {
    // A final verdict about THIS document: it cannot be converted, so there is
    // nothing to index. Returning an empty extraction — rather than throwing —
    // is what gives it a row with no chunks, which is exactly how the
    // unreadable list finds it (unsearchable.ts), with nothing to wire up.
    return { chunks: [], pageCount: null, text: "" };
  }

  const word = isWordFile(absPath);
  const pages = await deps.extractPdf(outcome.artifactPath, { outline: word });
  const sections = word ? collectHeadingSections(pages) : [];

  return {
    chunks: chunkPages(pages).map((chunk) => ({
      text: chunk.text,
      locator: word
        ? headingLocatorAt(sections, chunk.page, chunk.charStart)
        : { kind: "slide", slide: chunk.page },
    })),
    // A presentation's slides are its own units and the converter maps them
    // one to one. A Word document's pages are the RENDERER's — LibreOffice's
    // pagination is not the reader's Word — so the row says nothing rather
    // than something false, the same call `ChunkLocator` makes one level down.
    pageCount: isPresentationFile(absPath) ? pages.length : null,
    text: pages.map((page) => page.text).join("\n"),
  };
}

/**
 * Embeds every chunk and inserts the resulting kb_chunks rows for
 * `documentId`. Returns the number of chunks written — zero means the
 * document is indexed but unsearchable (e.g. an image-only scan whose text
 * layer is empty, or a workbook whose every sheet is hidden), which callers
 * must report as such rather than as a successful index.
 */
async function writeChunks(
  documentId: string,
  orgId: string,
  sourcePath: string,
  chunks: LocatedChunk[],
  deps: IngestDeps,
  onChunkProgress?: ChunkProgressCallback
): Promise<number> {
  if (chunks.length === 0) return 0;

  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_PROGRESS_BATCH) {
    const batch = chunks.slice(i, i + EMBED_PROGRESS_BATCH);
    vectors.push(...(await deps.embed(batch.map((chunk) => chunk.text))));
    // Only BETWEEN batches. The last batch's report would say exactly what the
    // per-file report following it immediately says, and an extra report that
    // carries no new information is a write the worker pays for twice.
    if (vectors.length < chunks.length) await onChunkProgress?.(vectors.length, chunks.length);
  }

  await db.insert(kbChunks).values(
    chunks.map((chunk, i) => ({
      documentId,
      orgId,
      sourcePath,
      chunkText: chunk.text,
      // Decided by `extractDocument`, per format, against the closed union in
      // locator.ts (#933): a page for a PDF, a sheet + row range for a
      // spreadsheet. This function no longer knows which, which is the point —
      // adding the heading and slide producers (#938) touches the dispatch and
      // not the write.
      locator: chunk.locator,
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
async function ingestFile(
  orgId: string,
  absPath: string,
  deps: IngestDeps,
  resolveArtifact: ResolveArtifact,
  onChunkProgress?: ChunkProgressCallback
): Promise<FileOutcome> {
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
    // Self-healing status: the status is a pure function of the path
    // (archive-paths.ts), so a stored value can only disagree after a rule
    // change or a pre-backfill row. The content-hash skip below would
    // otherwise freeze that disagreement forever.
    const status = statusForPath(absPath);
    if (existing.status !== status) {
      await db.update(kbDocuments).set({ status }).where(eq(kbDocuments.id, existing.id));
    }

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
    const { chunks } = await fileStep(absPath, () =>
      extractDocument(absPath, deps, resolveArtifact)
    );
    const written = await writeChunks(existing.id, orgId, absPath, chunks, deps, onChunkProgress);
    return written > 0 ? "indexed" : "unsearchable";
  }

  // Extract BEFORE deleting the old version: a file that changed into
  // something unparseable throws here and stays a `failed` update, with the
  // last good document and its chunks still searchable. Deleting first would
  // turn that same failure into silent data loss on a success response.
  const extracted = await fileStep(absPath, () => extractDocument(absPath, deps, resolveArtifact));

  if (existing) {
    // Content changed since the last ingest: replace wholesale. Deleting
    // the document row cascades to its (now stale) chunks via the
    // kb_chunks.document_id FK.
    await db.delete(kbDocuments).where(eq(kbDocuments.id, existing.id));
  }

  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId,
      contentHash,
      sourcePath: absPath,
      status: statusForPath(absPath),
      pageCount: extracted.pageCount,
      mtime: fileStat.mtime,
      lang: detectLang(extracted.text),
    })
    .returning();

  const written = await writeChunks(
    doc.id,
    orgId,
    absPath,
    extracted.chunks,
    deps,
    onChunkProgress
  );
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
  discovered: ReadonlyMap<string, number>
): Promise<number> {
  const existingForOrg = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, orgId));

  const vanishedIds: string[] = [];
  for (const doc of existingForOrg) {
    if (!isUnderRoot(doc.sourcePath, rootDir)) continue;
    if (discovered.has(doc.sourcePath)) continue;
    vanishedIds.push(doc.id);
  }

  // Single batched DELETE instead of one per vanished document.
  if (vanishedIds.length > 0) {
    await db.delete(kbDocuments).where(inArray(kbDocuments.id, vanishedIds));
  }
  return vanishedIds.length;
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
  const perRoot: Array<{ rootDir: string; discovered: Map<string, number> }> = [];
  for (const rootDir of rootDirs) {
    const discovered = await discoverFiles(rootDir, allowedExtensions);
    if (discovered === null) continue;
    perRoot.push({ rootDir, discovered });
  }

  // Deduplicated across roots, but ordered so each file is ingested while its
  // first root is being processed — the order only matters for readability of
  // the progress stream, not for correctness. Deduplication covers the byte
  // total too: a file granted under both /data and /data/hr is one unit of
  // work and must be weighed once, or the run would stop short of its total.
  const queue: Array<{ absPath: string; bytes: number }> = [];
  const seen = new Set<string>();
  for (const { discovered } of perRoot) {
    for (const [absPath, bytes] of discovered) {
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      queue.push({ absPath, bytes });
    }
  }

  // Converts in queue order, in batches, as the loop below reaches Office
  // documents — see officeArtifacts for why this is not a pre-pass.
  const resolveArtifact = officeArtifacts(queue, deps);

  const tally: Record<FileOutcome, number> = { indexed: 0, skipped: 0, unsearchable: 0 };
  let failed = 0;
  let processed = 0;
  let processedBytes = 0;
  let removed = 0;
  // Orthogonal to the outcome tally: an archived document is ALSO indexed or
  // skipped (archived files are fully ingested; only default retrieval hides
  // them). Counted only for files that actually have a document row, so a
  // `failed` file under OLD/ inflates neither bucket.
  let archived = 0;
  const total = queue.length;
  const totalBytes = queue.reduce((sum, file) => sum + file.bytes, 0);
  const snapshot = (): IngestResult => ({ ...tally, removed, failed, archived });

  /** `inFlightBytes` is the part of the CURRENT file already embedded — see the callback below. */
  const report = (inFlightBytes = 0) =>
    opts.onProgress?.({
      processed,
      total,
      processedBytes: processedBytes + inFlightBytes,
      totalBytes,
      counts: snapshot(),
    });

  // Reported before any work: "0 of N" is what tells a caller the run started
  // and how big it is. A caller that hears nothing until the first file lands
  // cannot tell a slow run from a dead one.
  await report();

  for (const { absPath, bytes } of queue) {
    try {
      const outcome = await ingestFile(
        orgId,
        absPath,
        deps,
        resolveArtifact,
        (embedded, chunkTotal) =>
          // Credit this file's bytes in proportion to the chunks embedded from
          // it. Its chunk count IS known once it is split, and that is the one
          // thing chunk-level progress is uniquely good for: without it the
          // compilation PDF worth 38% of the corpus would hold both bar and ETA
          // still for over an hour (#907).
          report(chunkTotal > 0 ? Math.round((bytes * embedded) / chunkTotal) : 0)
      );
      tally[outcome]++;
      if (isArchivedPath(absPath)) archived++;
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
    // A file that failed still moved the run forward, so its bytes go behind us
    // too — progress measures how much of the corpus is done, not how much of
    // it succeeded.
    processedBytes += bytes;
    await report();
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

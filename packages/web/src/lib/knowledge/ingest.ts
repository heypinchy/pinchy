/**
 * Knowledge-base ingest pipeline (server-side): discover -> extract -> chunk
 * -> embed -> upsert.
 *
 * Idempotent on (orgId, sourcePath, contentHash):
 *   - unchanged file (same content hash) with chunks already present -> skip.
 *   - unchanged file whose last read did not finish (a vision call failed, a
 *     conversion gave up) -> read again and rebuild its chunks in place, for
 *     at most MAX_INCOMPLETE_READS reads in a row.
 *   - unchanged file whose document row has zero chunks -> rebuild chunks in
 *     place, unless the row records an empty read that nothing available to
 *     this run could improve on (see the zero-chunk branch below).
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
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { and, count, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import { inBatches, rowsPerInsert } from "@/db/insert-batches";
import { errorLine, LOG_PATH_MAX, LOG_REASON_MAX, oneLine } from "@/lib/log-line";

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  isAllowedExtension,
  isDenylistedDirName,
  isDenylistedFileName,
  isHiddenSegment,
} from "./exclude-globs";
import { statusForPath } from "./archive-paths";
import { orderForIngest } from "./ingest-order";
import type { QueuedFile } from "./folder-plan";
import { buildPathFilter } from "./path-filter";
import { recordUnsupportedFiles, unsupportedFileType } from "./unsupported-files";
import { unsupportedFileKind } from "./unsupported-kind";
import { chunkPages } from "./chunk";
import { DEFAULT_BATCH_SIZE } from "./embeddings";
import { detectLang } from "./lid";
import { collectHeadingSections, headingLocatorAt } from "./heading-sections";
import {
  isLegacyWorkbook,
  isOfficeFile,
  needsConversion,
  OfficeFileRejectedError,
  isPresentationFile,
  isMsgFile,
  isScanFile,
  isSpreadsheetFile,
  isTextFile,
  isWordFile,
  OFFICE_CONVERT_BATCH_SIZE,
} from "./office-formats";
import type { ChunkLocator } from "./locator";
import { OFFICE_ARTIFACT_FORMAT_VERSION, SCAN_ARTIFACT_FORMAT_VERSION } from "./office-artifacts";
import type { ConversionOutcome, OfficeSource } from "./office-convert";
import type { XlsxExtraction } from "./xlsx-extract";
import { readTextFile } from "./text-extract";
import { emailContextLine, formatEmailText, type ParsedEmail } from "./msg-extract";
import { isContentRejection, toStorableLocator, toStorableText } from "./stored-text";
import { databaseErrorBehind, systemicIngestError } from "./ingest-errors";
import type { IngestPage, IngestResult } from "./types";
import {
  copyVerifiedSource,
  hashVerifiedSource,
  SourceRefusedError,
  type SourceRefusal,
  type VerifiedCopy,
} from "./verified-source";

// IngestPage/IngestResult live in ./types (a runtime-free module) because
// db/schema.ts persists IngestResult as a jsonb column and cannot import from
// this file — it is what this file imports. Re-exported here so callers can
// keep treating the ingest module as the contract's home.
export type { IngestPage, IngestResult } from "./types";

/** What `IngestDeps.convertScan` made of a scanned TIFF. */
export interface ScanConversion {
  /** The PDF of its frames, one page each, where a citation will find it. */
  pdfPath: string;
  /** How many frames the TIFF has. */
  frames: number;
  /** How many of them are pages of `pdfPath`: the first `converted`, in order. */
  converted: number;
}

export interface IngestDeps {
  /** Batch-embeds chunk texts into dense vectors (embeddinggemma-300m, 768-dim). Prod: `(t) => embedTexts(t, embedCfg)`. */
  embed: (texts: string[]) => Promise<number[][]>;
  /**
   * Cuts each chunk text the embedder could not take whole into pieces it can,
   * one list per input (a text that fits is a list of one). Each piece is
   * stored as a chunk of its own under the original chunk's locator, so the
   * rows written are exactly the texts embedded. Prod:
   * `(t) => fitTextsForEmbedding(t, embedCfg)` — measured with the embedding
   * model's own tokenizer, because the chunker's 4-characters-per-token
   * estimate is what let a chunk past the local context in #1380. Unset =
   * chunks are embedded as they are.
   */
  fitForEmbedding?: (texts: string[]) => Promise<string[][]>;
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
  /**
   * Turns a scanned TIFF into a PDF of its frames, stored under `contentHash`
   * where a citation opens it (#1409). Prod: `tiffToPdfIsolated` into the scan
   * artifact store (kb-index-worker.ts). Called only when `ocrModel` is set —
   * a scan has no text layer, so without OCR there is nothing to convert for.
   *
   * A refusal of the file (not a TIFF inside, too large) is an
   * `OfficeFileRejectedError`; anything else is about the machine, and the
   * file counts as failed.
   *
   * Required for the same reason `convertOffice` is: once
   * `DEFAULT_ALLOWED_EXTENSIONS` names `.tif`, every caller's ingest WILL meet
   * one.
   */
  convertScan: (copyPath: string, contentHash: string) => Promise<ScanConversion>;
  /**
   * Reads a saved Outlook message into its headers and body (#1409). Prod:
   * `readMsgIsolated`, the fenced reader child (kb-index-worker.ts) — the
   * parser walks an untrusted Compound File.
   *
   * A refusal of the file (not a Compound File, too large, damaged) is an
   * `OfficeFileRejectedError`; anything else is about the machine, and the
   * file counts as failed. Required for the same reason `convertScan` is: once
   * `DEFAULT_ALLOWED_EXTENSIONS` names `.msg`, every caller's ingest WILL meet
   * one.
   */
  readEmail: (copyPath: string) => Promise<ParsedEmail>;
  /**
   * The vision model `extractPdf` reads scanned pages with this run, or null
   * when it reads the text layer only (no vision model, or `PINCHY_KB_OCR=off`).
   *
   * The extractor does the reading; this only NAMES it, so the ingest can tell
   * whether an unchanged document that came out empty last time could come out
   * differently now (`emptyExtractionBy`). Required for the same reason the
   * extractors are: a caller that forgot it would describe a run with OCR as
   * one without, and the blank scans it reads would be read again every run.
   */
  ocrModel: string | null;
  /**
   * Where the run puts the private copies its readers open (verified-source.ts
   * `copyVerifiedSource`). Prod: the artifact volume's `staging/`
   * (`stagingDirOf()`), which the index worker clears at start — so a copy a
   * killed run left behind does not outlive it, as it would in the
   * container's `/tmp` on the writable layer.
   */
  stagingDir: string;
}

/** Why ingest left a granted root out of a run; see `IngestOptions.onSkippedRoot`. */
export type SkippedRootReason = "missing" | "unreadable" | "emptied";

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
  /**
   * Called once, before the first file is touched, with every queued path in
   * the order the run will process them. `processed` in a later progress
   * report is a position in this list, which is what lets a caller say which
   * folder the run is in without a write per file (folder-plan.ts, #1386).
   * Each entry says whether the archive rule put the file in an archived
   * subfolder, which the run reads last (#1405).
   */
  onQueue?: (queue: readonly QueuedFile[]) => void | Promise<void>;
  /**
   * Further knowledge-base folders the archive rule reads paths relative to,
   * besides this run's own roots (archive-paths.ts, #1420). A document's
   * status is one value for the whole org while runs go agent by agent, so
   * the index worker passes every folder any agent searches: otherwise a
   * document under two nested grants would be classified differently by each
   * agent's run, and flip every night. Not ingested, not removed from.
   */
  archiveRoots?: readonly string[];
  /**
   * Called for every root the run left out: `missing` (nothing is there — the
   * folder was renamed or removed, or a link to it dangles), `unreadable`
   * (something is there but could not be looked at — permissions, a read
   * error mid-walk) or `emptied` (see `keepEmptiedFolders`). Such a root
   * contributes no files AND no removal pass. `missing` and `unreadable` are
   * apart because their fixes are: remove the grant, or fix the share (#1363).
   *
   * Ingest only reports; what a skipped root means for the run is the
   * caller's call. Without this, a run whose every root was skipped reads as
   * "0 indexed, success", which is exactly what an unmounted share looks like
   * night after night.
   */
  onSkippedRoot?: (rootDir: string, reason: SkippedRootReason) => void;
  /**
   * Treat a folder that turns up with nothing in it at all, while the index
   * still holds documents from under it, as unavailable rather than emptied:
   * nothing under it is removed. Applies to a root (reported through
   * `onSkippedRoot`) and to any folder below one (`onKeptFolder`).
   *
   * A network share that failed to mount is not an error under Docker but an
   * EMPTY directory — the bare mountpoint the bind mount shows instead — and
   * from inside the container that cannot be told apart from a folder somebody
   * emptied. Taking it at its word deletes every document indexed from it, and
   * getting them back is a full re-embed. The mountpoint need not be the
   * granted folder: grant /data with a share mounted at /data/contracts and a
   * failed mount is an empty folder INSIDE a root that is anything but empty.
   *
   * A folder that was deleted outright is gone rather than empty, and its
   * documents are removed as usual.
   */
  keepEmptiedFolders?: boolean;
  /** Called once per folder below a root whose documents `keepEmptiedFolders` kept. */
  onKeptFolder?: (folder: string) => void;
  /**
   * Called for every file the run refused to read because its path no longer
   * led to a regular file inside its folder — swapped for a link, reached
   * through a folder swapped for one, or no longer a regular file
   * (verified-source.ts). A file merely saved again since discovery is read.
   * The file is ALSO counted `failed`, and its indexed version is kept; this
   * only says why, so the caller can count refusals apart from broken files.
   */
  onRefusedFile?: (absPath: string, refusal: SourceRefusal) => void;
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

/**
 * What discovery makes of a basename: a document to ingest, a file whose type
 * the indexer cannot read (#1267), or something that was never a document — a
 * hidden file, an OS or temp artifact (exclude-globs.ts).
 *
 * The middle answer is the one that used to vanish. It is a file somebody put
 * on the share for a reason, so it is counted and listed; the last answer is
 * noise, and listing it would bury the scans an admin has to convert.
 */
function classifyFile(
  name: string,
  allowedExtensions: readonly string[]
): "eligible" | "unsupported" | "ignored" {
  if (isHiddenSegment(name)) return "ignored";
  if (isDenylistedFileName(name)) return "ignored";
  return isAllowedExtension(name, allowedExtensions) ? "eligible" : "unsupported";
}

/** One root as discovery found it: the files to ingest, and the ones it cannot (path → type). */
interface RootListing {
  files: Map<string, DiscoveredFile>;
  unsupported: Map<string, string>;
}

/**
 * One file as discovery found it: its weight for progress, and the REAL path
 * every later read opens (verified-source.ts) — the root's real path plus the
 * names walked below it.
 */
interface DiscoveredFile {
  bytes: number;
  realPath: string;
}

/**
 * Describes a listed file by an `lstat`, so a link is described as itself and
 * never as whatever it points at.
 *
 * Discovery must not fail over a single file: one that vanished between the
 * readdir and this lstat stays in the queue with no weight, and is counted
 * `failed` at read time, exactly as before. Dropping it instead would make the
 * removal pass believe it is gone.
 */
async function describeFile(realPath: string): Promise<DiscoveredFile> {
  try {
    return { bytes: (await lstat(realPath)).size, realPath };
  } catch {
    return { bytes: 0, realPath };
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
  realDir: string,
  allowedExtensions: readonly string[],
  listing: RootListing
): Promise<void> {
  const entries = await readdir(realDir, { withFileTypes: true });

  for (const entry of entries) {
    if (isHiddenSegment(entry.name)) continue;
    const absPath = join(dir, entry.name);
    const realPath = join(realDir, entry.name);

    // A symlink is neither: `Dirent` describes the link itself, so a link to a
    // file or to a folder is skipped here, and never followed.
    if (entry.isDirectory()) {
      if (isDenylistedDirName(entry.name)) continue;
      await walkDir(absPath, realPath, allowedExtensions, listing);
    } else if (entry.isFile()) {
      // No stat for an unsupported file: nothing reads it, and on a network
      // share an lstat per file is a round trip per file.
      const kind = classifyFile(entry.name, allowedExtensions);
      if (kind === "eligible") listing.files.set(absPath, await describeFile(realPath));
      else if (kind === "unsupported")
        listing.unsupported.set(absPath, unsupportedFileType(entry.name));
    }
  }
}

/**
 * Lists ingest-eligible files for a root that may be a directory OR a single
 * file, or says why the root could not be read at all: `missing` when nothing
 * is there, `unreadable` when something is but could not be listed.
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
): Promise<RootListing | "missing" | "unreadable"> {
  // The ROOT may be a link — it is the admin's grant, and a share mounted
  // elsewhere is a normal way to set one up — so it is resolved once, here.
  // Everything below it is walked by real path and never through a link.
  let realRoot;
  let rootStat;
  try {
    realRoot = await realpath(rootDir);
    rootStat = await stat(realRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
  }

  const listing: RootListing = { files: new Map(), unsupported: new Map() };
  if (rootStat.isFile()) {
    const name = basename(rootDir);
    const kind = classifyFile(name, allowedExtensions);
    if (kind === "eligible") listing.files.set(rootDir, await describeFile(realRoot));
    else if (kind === "unsupported") listing.unsupported.set(rootDir, unsupportedFileType(name));
    return listing;
  }
  // A socket, device, or dangling symlink: readable, and holds no documents.
  if (!rootStat.isDirectory()) return listing;

  try {
    await walkDir(rootDir, realRoot, allowedExtensions, listing);
    return listing;
  } catch {
    // The root vanished or turned unreadable mid-walk. Same reasoning as
    // above: a partial listing must not be mistaken for the whole truth.
    return "unreadable";
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

/**
 * The extractor's own version, recorded with every empty read
 * (`kb_documents.empty_extraction_by`).
 *
 * The reader's name says which model looked; it says nothing about the code
 * around it. Bump this whenever a change to extraction could find text a past
 * read missed — the scan heuristic, the OCR page cap or prompt, a pdfjs or
 * LibreOffice upgrade — and every document on record as empty is read once more.
 */
export const EXTRACTION_VERSION = 1;

/**
 * How many reads in a row may fail to finish before the document is left alone.
 *
 * A failed vision call is retried because an outage heals; a page the provider
 * rejects every time (an image over its size limit) does not, and without a
 * bound every other page of that document would be sent again every night.
 * Five runs is a working week of nightly reindexes — long enough to outlast a
 * provider outage or a weekend with the share unmounted.
 */
export const MAX_INCOMPLETE_READS = 5;

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
  /**
   * Whether the read did not finish its job: a vision call failed on one of
   * its pages (`IngestPage.ocrFailed`), or the converter gave up on it. The
   * result is then not this document's last word, so it is read again.
   */
  incomplete: boolean;
  /**
   * What read it, for the record of an empty read: OCR can change what a PDF
   * page yields, and nothing about a spreadsheet's hidden sheets, a document
   * the converter could not convert, a scan whose bytes were refused, a
   * text file, or an Outlook message.
   */
  reader: "pdf" | "sheets" | "converter" | "image" | "text" | "email";
}

/**
 * The artifact format version a document's chunks are read from: the current
 * one for every format the converter turns into something else first (an
 * Office document into a PDF, a legacy `.xls` into an `.xlsx`), the scan
 * store's own for a TIFF, none for every other format.
 *
 * Recorded on the row (`kb_documents.artifact_format_version`) and compared on
 * every run, because the artifact store alone cannot carry a change of rules
 * to an unchanged document: its hash matches, it has chunks, and it never asks
 * the store for anything. A row whose version is not this one is converted and
 * read again — its chunks, and the artifact a citation opens, then both come
 * from the current rules.
 */
function artifactFormatVersionFor(absPath: string): number | null {
  if (isScanFile(absPath)) return SCAN_ARTIFACT_FORMAT_VERSION;
  return needsConversion(absPath) ? OFFICE_ARTIFACT_FORMAT_VERSION : null;
}

/** The fields every page-shaped extraction derives from its pages alike. */
function fromPages(pages: readonly IngestPage[]): Pick<ExtractedDocument, "text" | "incomplete"> {
  return {
    text: pages.map((page) => page.text).join("\n"),
    incomplete: pages.some((page) => page.ocrFailed),
  };
}

/**
 * Hands out the converted artifact (a PDF, or an `.xlsx` for a legacy `.xls`)
 * for a source the converter takes, converting in batches as
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
 * content, so the second run answers from cache (`office-convert.ts`). Which
 * is why the batch starts at the document that asked rather than at the head
 * of the queue — a skipped document never asks, so a batch cut from the front
 * would convert exactly what the run is about to leave alone.
 *
 * Nor does a document its own turn will skip join a later document's batch
 * (`turnWillSkip`): an unchanged indexed document would cost a full verified
 * copy, and a settled refusal — one the converter could not convert, read as
 * often as it is owed — a LibreOffice run, on every run that converts anything,
 * for an answer its turn never asks for.
 *
 * Every document in a batch is answered by that batch, including when the
 * converter rejects outright. One event, one answer: an unanswered document
 * would come back for a slice of its own.
 *
 * The converter is handed private copies, never paths on the share — the
 * asking document's own, and one streamed here for each other document in the
 * batch through the same checks as every other source read
 * (`copyVerifiedSource`). A document that cannot be copied that way is left
 * out of the batch and NOT answered: its own turn reads it again, and books
 * the refusal or the failure then, once. Each copy goes with its path on the
 * share (`displayPath`), so what the converter logs and answers names the file
 * an admin can find, not the copy.
 *
 * Each answer is kept with the hash of the copy it was converted from, and is
 * given only to a turn asking with that same hash. A batch mate's own turn
 * takes a fresh copy, and a save in between would otherwise pair the new
 * bytes' hash with the old bytes' artifact: chunks from the old version that
 * no later run re-reads, and a viewer that hashes the file it opens and finds
 * no artifact for it. A mismatch converts the asking document's own copy.
 */
function officeArtifacts(
  queue: readonly { absPath: string; realPath: string }[],
  deps: IngestDeps,
  turnWillSkip: (file: { absPath: string; realPath: string }) => Promise<boolean>,
  batchSize = OFFICE_CONVERT_BATCH_SIZE
): ResolveArtifact {
  const pending = queue.filter((file) => needsConversion(file.absPath));
  const positionOf = new Map(pending.map((file, i) => [file.absPath, i]));
  const done = new Map<string, { hash: string; outcome: ConversionOutcome }>();

  return async (absPath, contentHash, copyPath) => {
    const known = done.get(absPath);
    if (known?.hash === contentHash) return known.outcome;

    const start = positionOf.get(absPath);
    if (start === undefined) {
      // Only a caller outside this run's queue can land here. Retryable
      // rather than final: nothing was learned about the document.
      return unavailable(absPath, "document is not part of this run's queue");
    }

    // The batch begins at the document that ASKED, not at the head of the
    // queue. Everything before it was either converted already or skipped as
    // unchanged — and a skipped document never asks, so converting it ahead of
    // time is work this run throws away. It is not free work either: every
    // document in a batch is read in full and copied before the converter sees
    // it, even one the artifact store already holds.
    const batch: { path: string; hash: string }[] = [{ path: absPath, hash: contentHash }];
    const sources: OfficeSource[] = [{ absPath: copyPath, contentHash, displayPath: absPath }];
    const copies: VerifiedCopy[] = [];

    try {
      for (let i = start + 1; i < pending.length && batch.length < batchSize; i++) {
        const mate = pending[i];
        if (done.has(mate.absPath)) continue;
        let copy;
        try {
          if (await turnWillSkip(mate)) continue;
          copy = await copyVerifiedSource(mate.realPath, mate.absPath, deps.stagingDir);
        } catch {
          // Refused, unreadable, no room for the copy, or its row could not
          // be looked up. Not answered: see the doc comment above.
          continue;
        }
        copies.push(copy);
        batch.push({ path: mate.absPath, hash: copy.hash });
        sources.push({ absPath: copy.path, contentHash: copy.hash, displayPath: mate.absPath });
      }

      const outcomes = await deps.convertOffice(sources);
      batch.forEach(({ path, hash }, i) => {
        if (outcomes[i]) {
          done.set(path, { hash, outcome: outcomes[i] });
        } else {
          // The converter returned fewer outcomes than it was given sources,
          // which is a broken contract rather than a statement about this
          // document. Retryable, so it must not be recorded as unreadable.
          done.set(path, {
            hash,
            outcome: unavailable(path, "converter returned no outcome for this document"),
          });
        }
      });
    } catch (err) {
      // `convertOfficeFiles` reports an unusable converter as an outcome, but
      // it can still reject — constructing the artifact store creates its
      // directory, and an unmounted volume throws there. Answering the WHOLE
      // batch is what keeps that one event one event: leaving the others
      // unanswered would send each of them back for a fresh slice of the
      // queue, dragging unrelated documents through LibreOffice to learn the
      // same thing. Every one of them stays retryable, so no row is written
      // and nothing is branded unreadable (#936).
      const reason = `converter did not answer: ${err instanceof Error ? err.message : String(err)}`;
      for (const { path, hash } of batch) {
        done.set(path, { hash, outcome: unavailable(path, reason) });
      }
    } finally {
      // The artifact is in the store by now; the copies it was made from are
      // not needed past this batch. The asking document's copy is its caller's.
      await Promise.all(copies.map((copy) => copy.dispose()));
    }

    return (
      done.get(absPath)?.outcome ??
      unavailable(absPath, "converter returned no outcome for this document")
    );
  };
}

/** A retryable non-answer: the converter never judged this document (#936). */
function unavailable(sourcePath: string, reason: string): ConversionOutcome {
  return { sourcePath, status: "infrastructure", reason };
}

/**
 * Resolves the converted PDF for one Office source. `contentHash` is the sha256
 * the caller has already computed for its own idempotency check — the artifact
 * key, passed on so the converter need not read the file a second time — and
 * `copyPath` the private copy of exactly those bytes, which is what the
 * converter reads.
 */
type ResolveArtifact = (
  absPath: string,
  contentHash: string,
  copyPath: string
) => Promise<ConversionOutcome>;

/**
 * The server log's line for a file refused before anything was indexed from
 * it. The path is whatever name the file was given on the share, newlines
 * included, and a reason can quote the file or the file system — so neither is
 * printed as it stands: one refusal is one bounded line, and cannot pass for
 * another.
 */
function logRefusal(absPath: string, verdict: string, reason: string): void {
  console.warn(
    `[kb-ingest] ${oneLine(absPath, LOG_PATH_MAX)}: ${verdict} — ${oneLine(reason, LOG_REASON_MAX)}`
  );
}

/**
 * Reads one file into chunks with locators, dispatching on its extension.
 *
 * The dispatch is the whole Wave-2 shape, and every branch anchors on what the
 * format actually has (locator.ts):
 *
 *   PDF           `chunkPages` on the page the text came from
 *   spreadsheet   `extractXlsx`, sheet + row range — `XlsxChunk` IS the
 *                 locator field-for-field, so that half is a spread
 *   legacy `.xls` the `.xlsx` the converter made of it, read like any other
 *                 workbook — exceljs cannot parse BIFF (#1373)
 *   presentation  the converted PDF, slide N = page N
 *   Word          the converted PDF's outline, heading path — never a page,
 *                 which the renderer decides and the reader's Word disagrees
 *                 with
 *   TIFF scan     the PDF of its frames, through the PDF path: frame N =
 *                 page N
 *   plain text    no locator — it has no pages, so a citation opens the file
 *   Outlook mail  no locator, like plain text; headers above the body
 *
 * `absPath` is the document's identity and decides the dispatch; `copyPath`
 * is what the readers open — a private copy of the verified bytes, so none of
 * them is ever handed a path on the share.
 */
async function extractDocument(
  absPath: string,
  copyPath: string,
  deps: IngestDeps,
  resolveArtifact: ResolveArtifact,
  contentHash: string
): Promise<ExtractedDocument> {
  const read = await readDocument(absPath, copyPath, deps, resolveArtifact, contentHash);
  // The one place every reader's output passes through on its way to the
  // database (#1366). A NUL in a text layer or a sheet name is refused by
  // Postgres, and the other control characters are noise no search matches.
  // A chunk that held nothing else is not written at all: it would be a row
  // whose text says nothing, and an embedding of the empty string.
  const chunks = read.chunks
    .map((chunk) => ({
      text: toStorableText(chunk.text),
      locator: toStorableLocator(chunk.locator),
    }))
    .filter((chunk) => chunk.text.trim() !== "");
  return { ...read, chunks, text: toStorableText(read.text) };
}

/** The dispatch described above, as the readers return it — before it is made storable. */
async function readDocument(
  absPath: string,
  copyPath: string,
  deps: IngestDeps,
  resolveArtifact: ResolveArtifact,
  contentHash: string
): Promise<ExtractedDocument> {
  if (isOfficeFile(absPath)) {
    return extractOfficeDocument(absPath, copyPath, deps, resolveArtifact, contentHash);
  }

  if (isLegacyWorkbook(absPath)) {
    const artifactPath = await convertedArtifact(absPath, copyPath, resolveArtifact, contentHash);
    if (artifactPath === null) {
      return { chunks: [], pageCount: null, text: "", incomplete: true, reader: "converter" };
    }
    // The converted workbook is untrusted input like any other: the same
    // reader, behind the same limits, refuses it the same way.
    return readWorkbook(absPath, artifactPath, deps);
  }

  if (isSpreadsheetFile(absPath)) return readWorkbook(absPath, copyPath, deps);

  if (isScanFile(absPath)) {
    return extractScan(absPath, copyPath, deps, contentHash);
  }

  if (isTextFile(absPath)) {
    return extractTextFile(absPath, copyPath);
  }

  if (isMsgFile(absPath)) {
    return extractEmail(absPath, copyPath, deps);
  }

  return readPdfPages(await deps.extractPdf(copyPath));
}

/** A PDF's pages as chunks, each anchored on the page its text came from. */
function readPdfPages(pages: IngestPage[]): ExtractedDocument {
  return {
    chunks: chunkPages(pages).map((chunk) => ({
      text: chunk.text,
      locator: { kind: "page", page: chunk.page },
    })),
    pageCount: pages.length,
    ...fromPages(pages),
    reader: "pdf",
  };
}

/**
 * Reads an OOXML workbook — the original, or the `.xlsx` the converter made of
 * a legacy `.xls` — into chunks anchored on sheet and row range.
 *
 * `absPath` names the document in the log; `workbookPath` is what is opened.
 */
async function readWorkbook(
  absPath: string,
  workbookPath: string,
  deps: IngestDeps
): Promise<ExtractedDocument> {
  const extraction = await deps.extractXlsx(workbookPath).catch((err: unknown) => {
    if (!(err instanceof OfficeFileRejectedError)) throw err;
    // Refused unread: too large to load (a compressed bomb is the case that
    // matters), or not the workbook its name says (a broken archive, a
    // number format exceljs would choke on). That is a verdict on THIS file,
    // and a final one — retrying reads the same bytes — so it becomes a row
    // with no chunks, which is exactly how the unreadable list
    // (unsearchable.ts) finds it, with its reason in the server log.
    logRefusal(absPath, "not read", err.message);
    return null;
  });
  if (extraction === null) {
    return { chunks: [], pageCount: null, text: "", incomplete: false, reader: "sheets" };
  }
  return {
    chunks: extraction.chunks.map(({ text, sheet, startRow, endRow }) => ({
      text,
      locator: { kind: "sheet", sheet, startRow, endRow },
    })),
    pageCount: null,
    text: extraction.chunks.map((chunk) => chunk.text).join("\n"),
    incomplete: false,
    reader: "sheets",
  };
}

/**
 * Reads a scanned TIFF through the PDF its frames make (#1409): the scanned-PDF
 * path's OCR, page budget, retry rule and page citations, without a second OCR
 * path. Frame N is page N, and the citation opens that PDF on it.
 */
async function extractScan(
  absPath: string,
  copyPath: string,
  deps: IngestDeps,
  contentHash: string
): Promise<ExtractedDocument> {
  // A scan has no text layer, so a run without OCR would decode it for
  // nothing. Recorded as an empty PDF read without OCR — exactly a blank
  // scanned PDF's record — so the first run with a vision model reads it.
  if (!deps.ocrModel) {
    return { chunks: [], pageCount: null, text: "", incomplete: false, reader: "pdf" };
  }

  const conversion = await deps.convertScan(copyPath, contentHash).catch((err: unknown) => {
    if (!(err instanceof OfficeFileRejectedError)) throw err;
    // Not a TIFF inside, or over a limit: a verdict on these bytes, as final
    // as a refused workbook — and no vision model reads them differently.
    logRefusal(absPath, "not read", err.message);
    return null;
  });
  if (conversion === null) {
    return { chunks: [], pageCount: null, text: "", incomplete: false, reader: "image" };
  }

  const read = readPdfPages(await deps.extractPdf(conversion.pdfPath));
  // The frames past the OCR budget are not pages of the PDF, but they are
  // pages of the document.
  return { ...read, pageCount: conversion.frames };
}

/**
 * Reads a plain-text file in the encoding its author saved it in
 * (text-extract.ts). It has no pages, so its chunks carry no locator, and the
 * citation names the file without linking it: the viewer shows PDFs only.
 */
async function extractTextFile(absPath: string, copyPath: string): Promise<ExtractedDocument> {
  const text = await readTextFile(copyPath).catch((err: unknown) => {
    if (!(err instanceof OfficeFileRejectedError)) throw err;
    logRefusal(absPath, "not read", err.message);
    return null;
  });
  if (text === null) {
    return { chunks: [], pageCount: null, text: "", incomplete: false, reader: "text" };
  }
  return {
    chunks: chunkPages([{ page: 1, text }]).map((chunk) => ({ text: chunk.text, locator: null })),
    pageCount: null,
    text,
    incomplete: false,
    reader: "text",
  };
}

/**
 * The converter's artifact for a document, or `null` when the converter
 * refused THIS document. Throws when the converter never got to judge it.
 *
 * - Unavailable (out of memory, timed out, binary missing): throwing keeps the
 *   existing row and its chunks untouched and counts the file `failed`, so a
 *   memory squeeze cannot brand a perfectly good document as permanently
 *   unreadable (#936).
 * - Refused: there is nothing to index. The caller returns an empty
 *   extraction — rather than throwing — which gives it a row with no chunks,
 *   exactly how the unreadable list finds it (unsearchable.ts). Incomplete
 *   all the same: `failed` also covers causes that are not about the document
 *   — a source briefly unreadable on a network share, LibreOffice exiting
 *   without an artifact — so it is retried a few runs before it is taken as
 *   final.
 *
 * The unreadable list never says why, and the admin-facing counts must not
 * name paths, so the refusal log is the only place an operator learns which
 * document was refused and for what — logged on every run that refuses it,
 * not only the last. The reason holds no document text, but it can quote
 * names read from the file and the file's own path, so `logRefusal` keeps it
 * to one line.
 */
async function convertedArtifact(
  absPath: string,
  copyPath: string,
  resolveArtifact: ResolveArtifact,
  contentHash: string
): Promise<string | null> {
  const outcome = await resolveArtifact(absPath, contentHash, copyPath);
  if (outcome.status === "infrastructure") {
    throw new Error(`office conversion unavailable: ${outcome.reason ?? "unknown"}`);
  }
  if (outcome.status !== "converted" || !outcome.artifactPath) {
    logRefusal(absPath, "not converted", outcome.reason ?? "unknown");
    return null;
  }
  return outcome.artifactPath;
}

/**
 * Reads a saved Outlook message (#1409): a header block — subject, sender,
 * recipients, date, attachment names — above the body (msg-extract.ts). Like
 * a text file it has no pages, so its chunks carry no locator and the citation
 * names the file. Every chunk after the first lost the header block, so it
 * starts with one line naming the mail.
 *
 * Attachment contents are not read: a citation could not point inside the
 * mail at them. Their names are in the header block, so a search for the file
 * name still finds the mail.
 */
async function extractEmail(
  absPath: string,
  copyPath: string,
  deps: IngestDeps
): Promise<ExtractedDocument> {
  const email = await deps.readEmail(copyPath).catch((err: unknown) => {
    if (!(err instanceof OfficeFileRejectedError)) throw err;
    logRefusal(absPath, "not read", err.message);
    return null;
  });
  if (email === null) {
    return { chunks: [], pageCount: null, text: "", incomplete: false, reader: "email" };
  }
  if (email.bodyTruncated) {
    logRefusal(absPath, "body cut", "longer than an indexed mail body may be");
  }
  const text = formatEmailText(email);
  const context = emailContextLine(email);
  return {
    chunks: chunkPages([{ page: 1, text }]).map((chunk, i) => ({
      text: i === 0 ? chunk.text : `${context}\n${chunk.text}`,
      locator: null,
    })),
    pageCount: null,
    text,
    incomplete: false,
    reader: "email",
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
  copyPath: string,
  deps: IngestDeps,
  resolveArtifact: ResolveArtifact,
  contentHash: string
): Promise<ExtractedDocument> {
  const artifactPath = await convertedArtifact(absPath, copyPath, resolveArtifact, contentHash);
  if (artifactPath === null) {
    return { chunks: [], pageCount: null, text: "", incomplete: true, reader: "converter" };
  }

  const word = isWordFile(absPath);
  const pages = await deps.extractPdf(artifactPath, { outline: word });
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
    ...fromPages(pages),
    reader: "pdf",
  };
}

/**
 * Replaces every chunk the embedder cannot take whole with the pieces it can,
 * each under the original chunk's locator (#1380). Without
 * `deps.fitForEmbedding` the chunks pass through unchanged.
 */
async function fitChunksForEmbedding(
  chunks: LocatedChunk[],
  deps: IngestDeps
): Promise<LocatedChunk[]> {
  if (!deps.fitForEmbedding || chunks.length === 0) return chunks;
  const fitted = await deps.fitForEmbedding(chunks.map((chunk) => chunk.text));
  if (fitted.length !== chunks.length) {
    throw new Error(
      `fitForEmbedding returned ${fitted.length} piece lists for ${chunks.length} chunks`
    );
  }
  return chunks.flatMap((chunk, i) => fitted[i].map((text) => ({ text, locator: chunk.locator })));
}

/**
 * Embeds every chunk, then writes the document row (`writeDocument`, which
 * returns its id) and the resulting kb_chunks rows in ONE transaction. Returns
 * the number of chunks written — zero means the document is indexed but
 * unsearchable (e.g. an image-only scan whose text layer is empty, or a
 * workbook whose every sheet is hidden), which callers must report as such
 * rather than as a successful index.
 *
 * Embedded first, written together: an embedder that goes down halfway, or a
 * database that refuses the rows, leaves the stored document — its record and
 * its chunks — exactly as it was, and a new document without a row at all.
 *
 * A refusal of THIS file's values (`isContentRejection`) is the file's failure,
 * not the run's (#1366), and so is anything else that is not systemic
 * (`systemicIngestError`, #1380): the per-file boundary in `ingestPaths`
 * decides. The database's own error is what travels, never the query
 * builder's wrapper, whose message quotes the document's text.
 */
async function writeChunks(
  writeDocument: (tx: Transaction) => Promise<string>,
  orgId: string,
  sourcePath: string,
  chunks: LocatedChunk[],
  deps: IngestDeps,
  onChunkProgress?: ChunkProgressCallback
): Promise<number> {
  chunks = await fitChunksForEmbedding(chunks, deps);
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_PROGRESS_BATCH) {
    const batch = chunks.slice(i, i + EMBED_PROGRESS_BATCH);
    vectors.push(...(await deps.embed(batch.map((chunk) => chunk.text))));
    // Only BETWEEN batches. The last batch's report would say exactly what the
    // per-file report following it immediately says, and an extra report that
    // carries no new information is a write the worker pays for twice.
    if (vectors.length < chunks.length) await onChunkProgress?.(vectors.length, chunks.length);
  }

  try {
    await db.transaction(async (tx) => {
      const documentId = await writeDocument(tx);
      const rows = chunks.map((chunk, i) => ({
        documentId,
        orgId,
        sourcePath,
        chunkText: chunk.text,
        // Decided by `extractDocument`, per format, against the closed union
        // in locator.ts (#933): a page for a PDF, a sheet + row range for a
        // spreadsheet. This function does not know which, which is the point
        // — adding the heading and slide producers (#938) touched the
        // dispatch and not the write.
        locator: chunk.locator,
        lang: detectLang(chunk.text),
        embedding: vectors[i],
      }));
      // In batches, because one statement binds at most 65,533 parameters
      // (insert-batches.ts) and a long document has more chunks than that —
      // inside this one transaction, so a refused batch still leaves the
      // stored document exactly as it was.
      for (const batch of inBatches(rows, rowsPerInsert(kbChunks))) {
        await tx.insert(kbChunks).values(batch);
      }
    });
  } catch (err) {
    const rejection = isContentRejection(err);
    // The database's own error, not the query builder's wrapper around it: the
    // wrapper's message quotes every parameter — the document's text and its
    // vectors — and would push the reason out of the bounded log line.
    if (rejection) throw new FileIngestError(sourcePath, rejection);
    throw databaseErrorBehind(err);
  }

  return chunks.length;
}

/**
 * What a re-read of an existing document changes besides adding chunks: the
 * record of the read, and whether the chunks already stored make way first.
 */
interface ChunkRewrite {
  record: ExtractionRecord;
  replaceStored: boolean;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applyRewrite(tx: Transaction, documentId: string, rewrite: ChunkRewrite) {
  if (rewrite.replaceStored) await tx.delete(kbChunks).where(eq(kbChunks.documentId, documentId));
  await tx.update(kbDocuments).set(rewrite.record).where(eq(kbDocuments.id, documentId));
}

/**
 * A file-level ingest failure: THIS file could not be read or parsed (corrupt
 * PDF, permission denied, vanished between the walk and the read), or the
 * database refused the values read from it (`writeChunks`). It names the file
 * for the log line. Since #1380 it is no longer the only error the per-file
 * boundary contains — everything that is not systemic is — but a systemic
 * cause inside one (a database connection lost mid-file) still stops the run.
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

/**
 * A progress write that failed inside a file's work. Carried out of the file
 * unwrapped, so the per-file boundary does not count the run's own
 * bookkeeping failing as that file's failure.
 */
class ProgressReportError extends Error {
  constructor(cause: unknown) {
    super("Reporting index progress failed", { cause });
    this.name = "ProgressReportError";
  }
}

/** Runs a file-scoped step, tagging anything it throws as a FileIngestError so the log line names the file it happened on. */
async function fileStep<T>(sourcePath: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw new FileIngestError(sourcePath, err);
  }
}

/** How one file ended up, mapping 1:1 onto the IngestResult counters of the same name. */
type FileOutcome = "indexed" | "skipped" | "unsearchable";

/** Which OCR a run reads PDF pages with, in the spelling the record stores. */
function ocrSetup(deps: IngestDeps): string {
  return deps.ocrModel ? `ocr:${deps.ocrModel}` : "no-ocr";
}

/** What a read leaves on its document row (`kb_documents`). */
type ExtractionRecord = {
  emptyExtractionBy: string | null;
  incompleteReads: number;
  artifactFormatVersion: number | null;
};

/**
 * What to record about a read, given how many reads before it in a row did
 * not finish.
 *
 * An empty read is recorded once it is settled — finished, or out of retries —
 * as "<extractor version>|<reader>", and only an EMPTY one, which is what keeps
 * the zero-chunk branch's other guarantee: a document that had chunks and lost
 * them (a crash mid-write, a hand-deleted kb_chunks row) carries no record, so
 * it is still rebuilt.
 */
function extractionRecord(
  absPath: string,
  extracted: ExtractedDocument,
  deps: IngestDeps,
  previousIncompleteReads: number
): ExtractionRecord {
  const incompleteReads = extracted.incomplete ? previousIncompleteReads + 1 : 0;
  const settled = incompleteReads === 0 || incompleteReads >= MAX_INCOMPLETE_READS;
  const reader = extracted.reader === "pdf" ? ocrSetup(deps) : extracted.reader;
  return {
    emptyExtractionBy:
      extracted.chunks.length === 0 && settled ? `${EXTRACTION_VERSION}|${reader}` : null,
    incompleteReads,
    artifactFormatVersion: artifactFormatVersionFor(absPath),
  };
}

/**
 * Whether reading this content again could find text the recorded empty read
 * did not.
 *
 * Yes when the extractor itself has changed since. Otherwise only for a PDF
 * read, and only when OCR has become available or the model changed: a
 * different reader may well read a scan the first one could not. No when this
 * run has no vision model while the last read had one — the text layer is all
 * a run without OCR sees, and a vision model already looked past it.
 */
function couldReadDifferently(recorded: string, deps: IngestDeps): boolean {
  const separator = recorded.indexOf("|");
  if (separator < 0 || recorded.slice(0, separator) !== String(EXTRACTION_VERSION)) return true;
  const reader = recorded.slice(separator + 1);
  if (reader !== "no-ocr" && !reader.startsWith("ocr:")) return false;
  const current = ocrSetup(deps);
  return current !== "no-ocr" && current !== reader;
}

/**
 * Whether a document whose row already records its current content is owed
 * another read — the one decision behind every skip of an unchanged file. A
 * batch of Office conversions asks it too (`officeArtifacts`), so a document
 * its own turn will skip is not converted on the way.
 *
 * `current` is whether the row's chunks came from the current artifact rules;
 * `storedChunks` how many it has. Both are only known when a read is owed.
 */
async function readOwed(
  existing: typeof kbDocuments.$inferSelect,
  absPath: string,
  deps: IngestDeps
): Promise<{ owed: false } | { owed: true; current: boolean; storedChunks: number }> {
  // Chunks read from an artifact the current conversion rules did not make
  // are owed a new read, whatever else is on record: the rules changed
  // because of what such an artifact may hold.
  const current = existing.artifactFormatVersion === artifactFormatVersionFor(absPath);

  // A read that did not finish is owed another one, chunks or not: a scan
  // with a typed cover sheet has chunks of its own even when every vision
  // call behind it failed.
  const retryOwed =
    !current || (existing.incompleteReads > 0 && existing.incompleteReads < MAX_INCOMPLETE_READS);

  // A file with no text at all: the last read found nothing. Reading it
  // again with the same setup would find the same nothing — and under the
  // nightly reindex, a blank scan would be rendered and sent to the vision
  // model again every night. So it is skipped like any unchanged file unless
  // this run could read it differently. Checked before the chunk count: on a
  // corpus of thousands of blank scans that is a query per document per night.
  if (
    !retryOwed &&
    existing.emptyExtractionBy !== null &&
    !couldReadDifferently(existing.emptyExtractionBy, deps)
  ) {
    return { owed: false };
  }

  const [{ value: storedChunks }] = await db
    .select({ value: count() })
    .from(kbChunks)
    .where(eq(kbChunks.documentId, existing.id));

  if (!retryOwed && storedChunks > 0) return { owed: false };
  return { owed: true, current, storedChunks };
}

/**
 * Whether this file's own turn will skip it: its row records the bytes on
 * disk now, and owes them no read (`readOwed`). Reads the file once to hash
 * it — the same read its turn pays for an unchanged file, and less than the
 * verified copy a batch would otherwise take of it.
 */
async function turnWillSkip(
  orgId: string,
  file: { absPath: string; realPath: string },
  deps: IngestDeps
): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, orgId), eq(kbDocuments.sourcePath, file.absPath)))
    .limit(1);
  if (!existing) return false;
  const { hash } = await hashVerifiedSource(file.realPath);
  if (existing.contentHash !== hash) return false;
  return !(await readOwed(existing, file.absPath, deps)).owed;
}

/**
 * Ingests one file: hash it, decide skip/recover/replace/insert, and write its
 * chunks. Whatever it throws is this file's failure unless
 * `systemicIngestError` says otherwise — the per-file boundary in
 * `ingestPaths` decides (#1380).
 */
async function ingestFile(
  orgId: string,
  absPath: string,
  realPath: string,
  status: "active" | "archived",
  deps: IngestDeps,
  resolveArtifact: ResolveArtifact,
  onChunkProgress?: ChunkProgressCallback
): Promise<FileOutcome> {
  // Every read goes through a verified open (verified-source.ts), and none
  // holds the file whole: a whole-file buffer here stayed alive across every
  // await below — through an Office file's conversion and the embedding.
  //
  // First the hash, streamed, which is all an unchanged file costs. Only a
  // file that must be read is then streamed into a private copy, the one path
  // the extractors are handed — verified again, so a link swapped in between
  // the two is refused too. A row's hash always names the bytes that were
  // actually read: should the file have changed between hash and copy, the
  // COPY's hash and mtime are stored, through the replace path below.
  const { hash: contentHash } = await fileStep(absPath, () => hashVerifiedSource(realPath));
  const extract = () =>
    fileStep(absPath, async () => {
      const copy = await copyVerifiedSource(realPath, absPath, deps.stagingDir);
      try {
        const extracted = await extractDocument(
          absPath,
          copy.path,
          deps,
          resolveArtifact,
          copy.hash
        );
        return { extracted, contentHash: copy.hash, mtime: copy.mtime };
      } finally {
        await copy.dispose();
      }
    });

  const [existing] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.orgId, orgId), eq(kbDocuments.sourcePath, absPath)))
    .limit(1);

  // Set when a rebuild in place read bytes other than the ones it hashed.
  let reread: Awaited<ReturnType<typeof extract>> | undefined;
  if (existing && existing.contentHash === contentHash) {
    // Self-healing status: the status is a pure function of the path and the
    // searched folders (archive-paths.ts), so a stored value can only disagree
    // after a rule change, a grant change, or a pre-backfill row — including
    // every row the whole-path rule archived before #1420. The content-hash
    // skip below would otherwise freeze that disagreement forever.
    if (existing.status !== status) {
      await db.update(kbDocuments).set({ status }).where(eq(kbDocuments.id, existing.id));
    }

    const verdict = await readOwed(existing, absPath, deps);
    if (!verdict.owed) return "skipped";
    const { current, storedChunks } = verdict;
    // Retries already spent were spent under the earlier rules.
    const previousIncompleteReads = current ? existing.incompleteReads : 0;

    // Robustness case: a document row survives with zero chunks and no
    // empty read on record (written by a version that inserted the document
    // before its chunks and crashed in between, an operator hand-deleted
    // kb_chunks rows, or the row predates the record), or its last read is
    // owed a retry — which
    // a read from an earlier artifact format always is. The
    // content hash still matches the file on disk, so a naive "hash matches ->
    // skip" would leave this document unsearchable while silently reporting
    // success. We read it again instead and rebuild its chunks in place (same
    // id, no duplicate row).
    const read = await extract();
    // Unless the file was saved between the hash and the copy: then the reader
    // was handed NEW bytes, and rebuilding in place would file their text
    // under the old hash — which a revert matches, so every later run would
    // skip the document with text no longer on disk. New bytes are a change
    // like any other, and take the replace path below with what was read.
    if (read.contentHash !== contentHash) {
      reread = read;
    } else {
      const { extracted } = read;
      // A retry that fails worse than the read before it must not cost the text
      // that read found: an outage that returned keeps what is stored. Never
      // chunks from an earlier artifact format, though — what the current rules
      // refuse must not stay searchable through what the earlier ones made.
      const keepStored =
        current &&
        storedChunks > 0 &&
        extracted.incomplete &&
        extracted.chunks.length < storedChunks;
      const record = extractionRecord(absPath, extracted, deps, previousIncompleteReads);
      const rewrite: ChunkRewrite = {
        // A document that keeps its chunks is not an empty one.
        record: keepStored ? { ...record, emptyExtractionBy: null } : record,
        replaceStored: storedChunks > 0 && !keepStored,
      };
      const written = await writeChunks(
        async (tx) => {
          await applyRewrite(tx, existing.id, rewrite);
          return existing.id;
        },
        orgId,
        absPath,
        keepStored ? [] : extracted.chunks,
        deps,
        onChunkProgress
      );
      if (keepStored) return "skipped";
      return written > 0 ? "indexed" : "unsearchable";
    }
  }

  // Extract BEFORE deleting the old version: a file that changed into
  // something unparseable throws here and stays a `failed` update, with the
  // last good document and its chunks still searchable. Deleting first would
  // turn that same failure into silent data loss on a success response.
  const { extracted, contentHash: readHash, mtime } = reread ?? (await extract());

  const written = await writeChunks(
    async (tx) => {
      if (existing) {
        // Content changed since the last ingest: replace wholesale. Deleting
        // the document row cascades to its (now stale) chunks via the
        // kb_chunks.document_id FK — inside the transaction that writes the
        // new version, so a refused write keeps the last good one searchable.
        await tx.delete(kbDocuments).where(eq(kbDocuments.id, existing.id));
      }
      const [doc] = await tx
        .insert(kbDocuments)
        .values({
          orgId,
          contentHash: readHash,
          sourcePath: absPath,
          status,
          pageCount: extracted.pageCount,
          mtime,
          lang: detectLang(extracted.text),
          // Written with the row and its chunks, in one transaction: an empty
          // read is only ever recorded when there are NO chunks to write, and
          // the row never exists without the chunks it was read with.
          ...extractionRecord(absPath, extracted, deps, 0),
        })
        .returning({ id: kbDocuments.id });
      return doc.id;
    },
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
  discovered: ReadonlyMap<string, DiscoveredFile>,
  emptyFolders: EmptyFolderCheck | null
): Promise<number> {
  const existingForOrg = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, orgId));

  const vanishedIds: string[] = [];
  for (const doc of existingForOrg) {
    if (!isUnderRoot(doc.sourcePath, rootDir)) continue;
    if (discovered.has(doc.sourcePath)) continue;
    if (emptyFolders && (await emptyFolders.keeps(doc.sourcePath, rootDir))) continue;
    vanishedIds.push(doc.id);
  }

  // Single batched DELETE instead of one per vanished document.
  if (vanishedIds.length > 0) {
    await db.delete(kbDocuments).where(inArray(kbDocuments.id, vanishedIds));
  }
  return vanishedIds.length;
}

/** Whether the index holds any document from under `rootDir` — what makes an empty root suspicious rather than merely empty. */
async function hasDocumentsUnder(orgId: string, rootDir: string): Promise<boolean> {
  const [doc] = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(
      and(eq(kbDocuments.orgId, orgId), buildPathFilter([rootDir], sql`${kbDocuments.sourcePath}`))
    )
    .limit(1);
  return doc !== undefined;
}

/**
 * Decides, for a document whose file has vanished, whether it vanished into an
 * EMPTY folder — the signature of a share that failed to mount below a root.
 *
 * Walks up from the document's folder to the nearest one that still exists
 * (stopping at the root, which was already found readable and non-empty): if
 * that folder holds nothing at all, the document is kept. Folders are looked
 * at once per run however many documents sit under them.
 */
interface EmptyFolderCheck {
  keeps(sourcePath: string, rootDir: string): Promise<boolean>;
}

function emptyFolderCheck(onKeptFolder?: (folder: string) => void): EmptyFolderCheck {
  // null = the folder does not exist; otherwise whether it has any entry.
  const listings = new Map<string, boolean | null>();
  const reported = new Set<string>();

  async function isEmpty(folder: string): Promise<boolean | null> {
    const cached = listings.get(folder);
    if (cached !== undefined) return cached;
    let answer: boolean | null;
    try {
      answer = (await readdir(folder)).length === 0;
    } catch {
      answer = null;
    }
    listings.set(folder, answer);
    return answer;
  }

  return {
    async keeps(sourcePath, rootDir) {
      let folder = dirname(sourcePath);
      while (isUnderRoot(folder, rootDir) && folder !== rootDir) {
        const empty = await isEmpty(folder);
        if (empty === null) {
          folder = dirname(folder);
          continue;
        }
        if (!empty) return false;
        if (!reported.has(folder)) {
          reported.add(folder);
          onKeptFolder?.(folder);
        }
        return true;
      }
      return false;
    },
  };
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
  const perRoot: Array<{
    rootDir: string;
    discovered: Map<string, DiscoveredFile>;
    unsupported: Map<string, string>;
  }> = [];
  for (const rootDir of rootDirs) {
    const listing = await discoverFiles(rootDir, allowedExtensions);
    if (listing === "missing" || listing === "unreadable") {
      opts.onSkippedRoot?.(rootDir, listing);
      continue;
    }
    const discovered = listing.files;
    if (
      opts.keepEmptiedFolders &&
      discovered.size === 0 &&
      (await hasDocumentsUnder(orgId, rootDir))
    ) {
      opts.onSkippedRoot?.(rootDir, "emptied");
      continue;
    }
    perRoot.push({ rootDir, discovered, unsupported: listing.unsupported });
  }

  // Counted once however many overlapping roots found a file, like `total`,
  // and split by whether the file is a document at all (#1410).
  const unreadable = new Map(perRoot.flatMap((root) => [...root.unsupported]));
  let unsupported = 0;
  let ignored = 0;
  for (const type of unreadable.values()) {
    if (unsupportedFileKind(type) === "unsupported") unsupported++;
    else ignored++;
  }

  // Deduplicated across roots: a file granted under both /data and /data/hr is
  // one unit of work and must be weighed once, or the run would stop short of
  // its total. Then ordered across ALL roots — current files before archived
  // ones, folder by folder — so a first index that runs for days has the part
  // people search complete first (ingest-order.ts, #1385).
  const unique = new Map<string, DiscoveredFile>();
  for (const { discovered } of perRoot) {
    for (const [absPath, file] of discovered) {
      if (!unique.has(absPath)) unique.set(absPath, file);
    }
  }
  // Every folder the archive rule may cut a path at: this run's roots, and the
  // ones other agents search (see `archiveRoots`).
  const classifyRoots = [...rootDirs, ...(opts.archiveRoots ?? [])];
  const queue = orderForIngest(
    [...unique].map(([absPath, file]) => ({ absPath, ...file })),
    classifyRoots
  );

  // Converts in queue order, in batches, as the loop below reaches Office
  // documents — see officeArtifacts for why this is not a pre-pass.
  const resolveArtifact = officeArtifacts(queue, deps, (file) => turnWillSkip(orgId, file, deps));

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
  const snapshot = (): IngestResult => ({
    ...tally,
    removed,
    failed,
    archived,
    unsupported,
    ignored,
  });

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
  await opts.onQueue?.(
    queue.map((file) => ({
      path: file.absPath,
      archived: statusForPath(file.absPath, classifyRoots) === "archived",
    }))
  );
  await report();

  for (const { absPath, bytes, realPath } of queue) {
    const status = statusForPath(absPath, classifyRoots);
    try {
      const outcome = await ingestFile(
        orgId,
        absPath,
        realPath,
        status,
        deps,
        resolveArtifact,
        async (embedded, chunkTotal) => {
          try {
            // Credit this file's bytes in proportion to the chunks embedded
            // from it. Its chunk count IS known once it is split, and that is
            // the one thing chunk-level progress is uniquely good for: without
            // it the compilation PDF worth 38% of the corpus would hold both
            // bar and ETA still for over an hour (#907).
            await report(chunkTotal > 0 ? Math.round((bytes * embedded) / chunkTotal) : 0);
          } catch (err) {
            // A progress write that fails is the run's bookkeeping failing,
            // not this file: it would fail the same way for every file after.
            throw new ProgressReportError(err);
          }
        }
      );
      tally[outcome]++;
      if (status === "archived") archived++;
    } catch (err) {
      // One unreadable or corrupt file, one chunk the embedder refuses, one
      // row the database will not take — each is a normal property of a real
      // corpus, so it costs itself and nothing else: without this boundary a
      // single bad file aborts the reindex for every other file, and under a
      // retrying job runner it fails identically forever (#1380: a first
      // reindex stopped at the same file on every run). Only an error that
      // would fail every remaining file the same way stops the run — see
      // ingest-errors.ts. The tally reported so far is the caller's last
      // honest word on what the run achieved before that happened.
      if (err instanceof ProgressReportError) throw err.cause;
      const systemic = systemicIngestError(err);
      if (systemic) throw systemic;
      const cause = err instanceof FileIngestError ? err.cause : err;
      // The admin-facing counts must not name paths (audit PII rule), so this
      // server log is the only place that says WHICH file failed and why.
      // The path and the cause — a file-system error, a reader's — can quote
      // the file name, so both go through the same escaping as a refusal: a
      // newline in a file name cannot write a line of its own. Never the
      // content: the cause is the database's own error or the embedder's,
      // not a wrapper that quotes the chunk text.
      console.error(
        `[kb-ingest] ${oneLine(`Ingest failed for ${absPath}`, LOG_PATH_MAX + 32)}`,
        errorLine(cause)
      );
      if (cause instanceof SourceRefusedError) opts.onRefusedFile?.(absPath, cause.refusal);
      failed++;
    }
    processed++;
    // A file that failed still moved the run forward, so its bytes go behind us
    // too — progress measures how much of the corpus is done, not how much of
    // it succeeded.
    processedBytes += bytes;
    await report();
  }

  // One check shared by every root, so overlapping roots (/data and /data/hr)
  // look at each folder once and report it once. An emptied ROOT counts here
  // too: /data/hr was skipped as a root, and /data's pass must not delete what
  // was under it either.
  //
  // The folders it keeps are collected as well: the list of unsupported files
  // follows the same rule as the documents, below.
  const keptFolders: string[] = [];
  const emptyFolders = opts.keepEmptiedFolders
    ? emptyFolderCheck((folder) => {
        keptFolders.push(folder);
        opts.onKeptFolder?.(folder);
      })
    : null;
  const skippedEmptiedRoots = new Set(
    rootDirs.filter((root) => !perRoot.some((kept) => kept.rootDir === root))
  );
  for (const { rootDir, discovered } of perRoot) {
    removed += await removeVanishedDocuments(
      orgId,
      rootDir,
      discovered,
      emptyFolders && {
        keeps: async (sourcePath, root) =>
          [...skippedEmptiedRoots].some((skipped) => isUnderRoot(sourcePath, skipped)) ||
          (await emptyFolders.keeps(sourcePath, root)),
      }
    );
  }

  // Last, beside the removal pass and for the same reason: it says what is on
  // the share NOW, so it is written only by a run that got to the end. A run
  // that died halfway leaves the previous list in place rather than half a new
  // one. A folder the run left as it was keeps its rows — a share that failed
  // to mount is no evidence that its files are gone.
  await recordUnsupportedFiles(
    orgId,
    perRoot.map(({ rootDir, unsupported: files }) => ({ rootDir, files })),
    [...skippedEmptiedRoots, ...keptFolders]
  );

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

/**
 * Converts page-shaped Office documents (.doc/.docx/.ppt/.pptx) to PDF for the
 * knowledge base (#936), and legacy `.xls` workbooks to `.xlsx` (#1373).
 * Standalone: wiring this into the ingest pipeline is #938's job, and serving
 * the artifact as a preview is #939's.
 *
 * ## Why convert instead of parsing natively
 *
 * Office support has to cover LEGACY formats: in the reference corpus 13 of 19
 * Office files are `.doc`/`.ppt`. The entire modern parsing ecosystem
 * (Docling, MarkItDown, Unstructured, anything on python-docx/python-pptx) is
 * OOXML-only and cannot read them. LibreOffice is the standard answer and here
 * it is the only one that covers the corpus.
 *
 * Conversion also buys what the citation chain depends on: ONE renderable
 * artifact whose pages agree with what the reader is shown, so a citation can
 * never point at something the user cannot see. OOXML spreadsheets take a
 * different path (#937/#940): they are read directly, never converted. A
 * legacy BIFF `.xls` is the one exception, because exceljs cannot parse it and
 * the only maintained JavaScript reader that can (SheetJS) ships its security
 * fixes outside npm. LibreOffice Calc turns it into an `.xlsx` — never a PDF,
 * whose page breaks no sheet citation could point at — and that workbook is
 * then read by the same isolated reader, behind the same limits, as any other.
 *
 * ## Three things this module exists to get right
 *
 * 1. **Batch, do not spawn per file.** Process startup dominates: 17 real
 *    corpus files convert in 14.2 s in one process vs 25.6 s one-per-file.
 *    Batches are bounded (`DEFAULT_BATCH_SIZE`), and a batch the converter
 *    did not survive is run again one document at a time
 *    (`runIsolatingKills`), so one document that takes LibreOffice down costs
 *    itself rather than its batch-mates.
 *
 * 2. **The exit code lies.** An input LibreOffice cannot load produces
 *    `Error: source file could not be loaded` on stderr, exit code **0**, and
 *    no output file — while every other file in the batch converts normally
 *    (verified against the real `libreoffice-writer` in the runtime image).
 *    A pipeline that trusts the return value books the document as converted
 *    and indexes nothing. So the artifact's existence is the evidence, never
 *    the exit code.
 *
 * 3. **OOM is distinguishable, and the difference is load-bearing.** Exit
 *    **137** (or a bare SIGKILL, which is what a direct spawn sees) means the
 *    container was too small — infrastructure, retryable. Exit 0 with no
 *    artifact means THIS document is unreadable — final — unless the volume
 *    got in the way: the output and LibreOffice's load-time scratch both land
 *    on the artifact volume, and a full one gives the same exit 0 and no
 *    file. The volume is asked, not
 *    LibreOffice's stderr (`outputVolumeFault`). Without the split,
 *    one memory squeeze brands perfectly good documents as permanently
 *    unreadable and nothing ever retries them.
 *
 * ## Verification: a lower bound, not an equality check
 *
 * Every conversion of the reference corpus was measured against an independent
 * extractor and no case lost content; all deviations were the ORACLE
 * under-reporting (a `.docx` came out +25 % because of headers/footers a raw
 * `word/document.xml` read cannot see; `catppt` stopped after the title slide,
 * 39 words vs 868, and mangled the very diacritics the customer cares about).
 * An equality round-trip is therefore unbuildable with these tools — it would
 * fire constantly. The check is `pdf_words >= source_words * (1 - ε)`: in that
 * direction a weak oracle can only miss a real loss, never raise a false
 * alarm. It is a tripwire against the failure that actually hurts (clipped
 * text), NOT a guarantee.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants, createWriteStream, type StatsFs } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readlink,
  rm,
  stat,
  statfs,
  symlink,
  unlink,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_PATH_MAX, LOG_REASON_MAX, oneLine } from "../log-line";

import { getOfficeArtifactStore, hashFileContents, OfficeArtifactStore } from "./office-artifacts";
import {
  convertedExtensionOf,
  countWords,
  OFFICE_CONVERT_BATCH_SIZE,
  OFFICE_EXTENSIONS,
  OfficeFileRejectedError,
  StagedCopyWriteError,
  isOfficeFile,
  type ConvertedExtension,
} from "./office-formats";
import type { StagedSource } from "./office-preflight";
import { extractPdfPages } from "./pdf-extract";
import { sidecarConverter } from "./office-converter-sidecar";
import {
  childEnv,
  killTree,
  runSoffice,
  type ConverterResult,
  type ConverterRun,
  type RunConverter,
} from "./office-soffice";
import {
  countDocxWordsIsolated,
  SheetReaderStoppedError,
  stageOfficeSourceIsolated,
} from "./xlsx-isolated";

/**
 * Re-exported so this module stays the one place a caller has to know about
 * for conversion. The definitions themselves live where the PREVIEW route and
 * the markdown renderer can reach them without pulling `child_process` and
 * pdfjs into a browser bundle (#939) — see `office-formats.ts` and
 * `office-artifacts.ts`.
 */
export { OFFICE_EXTENSIONS, isOfficeFile, hashFileContents };
export { runSoffice };
export type { ConverterResult, ConverterRun, RunConverter };

/**
 * Tolerance of the lower-bound word check. 10 % is head-room for tokenisation
 * noise between two extractors that will never agree exactly — hyphenation,
 * ligatures, soft hyphens, table cells joined with or without a separator all
 * move a word count by a few percent — while the failure this guards against
 * (a fixed-size text box whose overflow is silently dropped by the renderer)
 * loses whole blocks of text, far more than 10 %.
 *
 * The corpus cannot narrow this further: no measured conversion lost content
 * at all, so every observed deviation was in the tolerated direction. And the
 * clipping case has never actually fired on real data — the only fixture for
 * it is synthetic (see the tests). Treat 10 % as "wide enough to be quiet on
 * everything we have seen", not as a calibrated bound.
 */
export const OFFICE_VERIFY_EPSILON = 0.1;

/**
 * Files per converter process — the shared number, not a second spelling of it.
 * The ingest slices its queue against the same constant (office-formats.ts says
 * why it lives there), so the size the converter was measured at cannot be
 * capped by a slicer that disagrees.
 */
export const DEFAULT_BATCH_SIZE = OFFICE_CONVERT_BATCH_SIZE;

/** Per-batch wall-clock budget. The slowest single real file took 1.46 s; this is deliberately far above that. */
export function batchTimeoutMs(fileCount: number): number {
  return 60_000 + 10_000 * fileCount;
}

/**
 * Free space below which a missing PDF is blamed on the volume, not the
 * document: the unpacked package, plus
 * `2 × max(MIN_FREE_OUTPUT_BYTES, 2 × the staged source)` for the PDF.
 *
 * Two things land on the batch's volume. First the SCRATCH LibreOffice
 * unpacks a package into while loading it (its `TMPDIR` is inside the batch,
 * see `runSoffice`). When that runs out it reports exactly what an unloadable
 * document reports — exit 0, no PDF, `source file could not be loaded` — and
 * by the time the volume is asked the scratch is gone again. Measured in the
 * runtime image: a 152 KB `.docx` whose document.xml is 26.6 MB peaked at
 * 26 MB of scratch, failed to load on a 24 MiB volume and left 23.6 MiB free
 * behind it. So the unpacked size (`unpackedBytes` from the
 * preflight) is demanded in full; a legacy `.doc`/`.ppt` is not an archive
 * and adds nothing.
 *
 * Then the PDF, whose size is unknown — it was never written. The staged
 * source stands in for it: twice the source, never under the floor. That is
 * a guess, and no factor makes it a bound: the export embeds fonts and
 * re-encodes pictures (a PNG becomes a JPEG), so the PDF's size follows the
 * pictures' pixels, not the file's bytes. A 868 KiB `.doc` of five pictures
 * exports to a 13.6 MiB PDF, an 8.55 MB `.doc` of 200 screenshots to an
 * 81.9 MB one, 9.6 times the file (both measured in the runtime image).
 * 16 MiB is above any font set and above the first of those PDFs, and far
 * below what a volume that is merely busy has left. It also catches the case
 * measured on a nearly full volume: 4 KB left, the probe's write fits, the PDF does
 * not.
 *
 * And room for that PDF TWICE. LibreOffice exports into its `TMPDIR` — the
 * batch's, on this volume — and then copies the file into `--outdir`, so for
 * a moment it is on the volume twice; the temp copy goes before the next
 * document's. Measured in the runtime image, a `.doc` whose
 * PDF is 5,758 KiB: converts with 11,592 KiB free, fails the store with
 * 11,336 KiB (exit 0, no PDF, `impl_store … failed: 0x20d`) and leaves the
 * volume free again — and twice the PDF is 11,516 KiB, between the two.
 * Counted once, a changed 12 MB `.ppt` with a 14 MB PDF, on 26 MiB free,
 * would be judged the document's fault. So a document that came out without
 * a PDF is never held against it on a volume with less than 32 MiB left —
 * a volume that is nearly full, not one that is merely in use.
 *
 * The scratch and the PDF are added rather than maxed: measuring that
 * `.docx` shows the scratch released before the PDF is written, but
 * that is one document's behaviour, not a promise for every format.
 *
 * The error that costs least is the one this leans towards: a document
 * blamed on a volume too small to load it is read again next run — and the
 * operator is told about a volume that really is about to stop taking writes.
 *
 * What it gets wrong the other way, and why it stays: a PDF that outgrows the
 * guess, on a volume with room for the guess but not for that PDF twice, is
 * booked `failed`. The 81.9 MB PDF above fails the store on a 70 MiB volume
 * and leaves 64.5 MB free, against the 34 MB asked: on any volume with
 * between about 34 MB and twice the PDF (164 MB) free, the document is held
 * at fault. LibreOffice's output cannot settle it: the line it prints —
 * `impl_store … failed: 0xc10(Error Area:Io Class:Write Code:16)` — is
 * byte for byte what an all-hidden `.pptx` or `.ppt` prints on a roomy disk
 * (measured in the runtime image; a corrupt or truncated
 * file fails to LOAD instead, and an empty deck converts). Nor can a larger
 * factor: the deck it then wrongly blamed on the volume would be retried
 * every run, uncapped, where a wrong `failed` is an incomplete read and is
 * retried for `MAX_INCOMPLETE_READS` runs (ingest.ts) — the earlier version of
 * a changed file is lost meanwhile and it is listed unsearchable, which the
 * docs say. The volume being that full is what an operator can see and fix.
 */
export const MIN_FREE_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Free inodes below which the volume is out of files rather than bytes. A
 * batch creates a handful per document (staged copy, PDF, LibreOffice's temp
 * file) — under a hundred for a whole batch; a healthy filesystem reports
 * millions.
 */
export const MIN_FREE_OUTPUT_INODES = 1024;

/** The part of `statfs` the volume check reads. */
export type VolumeSpace = Pick<StatsFs, "bsize" | "bavail" | "files" | "ffree">;

export interface OfficeSource {
  absPath: string;
  /**
   * sha256 of the file's bytes — the artifact key. Optional because a
   * standalone caller may not have it; ingest already computes exactly this
   * for its own idempotency check and should pass it rather than pay for a
   * second read.
   */
  contentHash?: string;
  /**
   * What the log and the outcome's `reason` call this document, when `absPath`
   * is a private copy of it: the path on the share. A copy keeps the file's
   * basename in a staging directory of its own, so a line naming it reads like
   * the document and points at a file nobody can find. Defaults to `absPath`.
   */
  displayPath?: string;
}

/**
 * - `converted`      — an artifact is in the store; index it.
 * - `failed`         — THIS document cannot be converted, ever. Final: it
 *                      belongs on the unreadable list (#935), and retrying
 *                      costs a LibreOffice startup to learn the same thing.
 * - `infrastructure` — the converter never got to judge this document (out of
 *                      memory, timed out, binary missing). Retryable, and
 *                      recording it as unreadable would be a lie: without this
 *                      distinction one memory squeeze brands perfectly good
 *                      documents as permanently unreadable and nothing ever
 *                      retries them.
 */
export type ConversionStatus = "converted" | "failed" | "infrastructure";

export interface VerificationReport {
  /**
   * - `ok`         — the PDF cleared the lower bound.
   * - `short`      — it did not: content was lost, the conversion is rejected.
   * - `unverified` — no independent extractor for this format, so nothing was
   *                  checked. Deliberately NOT reported as `ok`.
   * - `cached`     — the artifact was verified when it was stored.
   */
  status: "ok" | "short" | "unverified" | "cached";
  sourceWords: number | null;
  pdfWords: number | null;
  epsilon: number;
}

export interface ConversionOutcome {
  sourcePath: string;
  status: ConversionStatus;
  /** Set for `converted` only. */
  artifactPath?: string;
  /**
   * Set for `converted`, and for a `failed` outcome the word-count check
   * refused (`status: "short"`) — ingest's .docx fallback reads it (#1406).
   */
  verification?: VerificationReport;
  /**
   * Diagnostic. Holds no document text, but it can quote names read from the
   * file (a part's, an entry's — escaped and cut short where they are quoted)
   * and the file system's own words, which may name the source path. A log
   * line built from it must still keep it to one line.
   */
  reason?: string;
}

export interface ConvertProgress {
  /** Documents whose conversion is behind us — including the ones that failed. */
  processed: number;
  /** Documents that actually need converting: cache hits are not counted, they are not work. */
  total: number;
}

/**
 * Vets one source and writes the bytes to convert to `staged`, answering with
 * what it did — or `null` to convert the file in place, through a link (what
 * the tests that fake the converter use). Throws `OfficeFileRejectedError` for
 * a file that must not reach a reader, `StagedCopyWriteError` when `staged`
 * cannot be written, and `SheetReaderStoppedError` when the process doing the
 * vetting stopped without a verdict.
 */
export type PrepareSource = (absPath: string, staged: string) => Promise<StagedSource | null>;

export interface ConvertOptions {
  store?: OfficeArtifactStore;
  runConverter?: RunConverter;
  /**
   * Where a batch is staged. The converter's business, not the store's: the
   * sidecar can only see its spool. Defaults to the one that belongs to the
   * default converter (see `defaultConverter`).
   */
  createStagingDir?: () => Promise<string>;
  /**
   * How a batch is removed again. Defaults to the converter's own when the
   * staging is the default one, and to a recursive delete when a caller
   * stages somewhere of its own.
   */
  removeStagingDir?: (dir: string) => Promise<void>;
  /**
   * Defaults to the real preflight (./office-preflight.ts), run in the reader
   * child (`stageOfficeSourceIsolated`): this process never holds the file.
   */
  prepareSource?: PrepareSource;
  /** Words in the converted PDF. Prod: the pdfjs text layer (./pdf-extract.ts). */
  countPdfWords?: (absPath: string) => Promise<number>;
  /**
   * Words the INDEPENDENT extractor sees in the original, or null when there is
   * none for this format. `absPath` is the staged copy; `displayPath` is what a
   * log line calls the document.
   */
  countSourceWords?: (absPath: string, displayPath: string) => Promise<number | null>;
  batchSize?: number;
  epsilon?: number;
  onProgress?: (progress: ConvertProgress) => void | Promise<void>;
  /** How full the artifact volume is. Prod: `fs.statfs`. */
  statfs?: (dir: string) => Promise<VolumeSpace>;
}

/** One document's slot in the run, so results can be returned in input order. */
interface WorkItem {
  absPath: string;
  /** What the converter turns it into — a PDF, or for a legacy workbook an `.xlsx` (#1373). */
  output: ConvertedExtension;
  /** See `OfficeSource.displayPath`. */
  displayPath: string;
  contentHash: string;
  /** Every input position that shares this content — two paths, one conversion. */
  positions: number[];
}

/**
 * Converts `sources` into the artifact store — a PDF each, or an `.xlsx` for a
 * legacy workbook — returning one outcome per source, in input order.
 *
 * Documents already in the store are returned without running the converter,
 * and identical content at two paths converts once — the store is keyed on
 * content, and a real corpus really does hold the same document twice.
 */
export async function convertOfficeFiles(
  sources: readonly OfficeSource[],
  options: ConvertOptions = {}
): Promise<ConversionOutcome[]> {
  if (sources.length === 0) return [];

  const store = options.store ?? getOfficeArtifactStore();
  const converter = defaultConverter(store);
  const runConverter = options.runConverter ?? converter.runConverter;
  const createStagingDir = options.createStagingDir ?? converter.createStagingDir;
  const removeStagingDir =
    options.removeStagingDir ??
    (options.createStagingDir ? removeTree : converter.removeStagingDir);
  const discardScratch = options.createStagingDir ? removeTree : converter.discardScratch;
  const prepareSource = options.prepareSource ?? defaultPrepareSource;
  const countPdfWords = options.countPdfWords ?? defaultCountPdfWords;
  const countSourceWords =
    options.countSourceWords ??
    ((absPath: string, displayPath: string) =>
      countSourceWordsWithOracle(absPath, {}, displayPath));
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const epsilon = options.epsilon ?? OFFICE_VERIFY_EPSILON;
  const readSpace = options.statfs ?? ((dir: string) => statfs(dir));

  const outcomes = new Array<ConversionOutcome>(sources.length);
  const byHash = new Map<string, WorkItem>();

  for (const [position, source] of sources.entries()) {
    let contentHash = source.contentHash;
    if (!contentHash) {
      try {
        contentHash = await hashFileContents(source.absPath);
      } catch (err) {
        // The file vanished or turned unreadable between discovery and here.
        // That is about THIS document, not the infrastructure.
        outcomes[position] = documentFailure(
          source.absPath,
          inOwnName(`unreadable source: ${reasonOf(err)}`, source.absPath, source.displayPath)
        );
        continue;
      }
    }

    const output = convertedExtensionOf(source.absPath);
    const cached = await store.get(contentHash, output);
    if (cached) {
      outcomes[position] = {
        sourcePath: source.absPath,
        status: "converted",
        artifactPath: cached,
        verification: { status: "cached", sourceWords: null, pdfWords: null, epsilon },
      };
      continue;
    }

    // Keyed on the target too: the same bytes under `.doc` and `.xls` are two
    // conversions, and neither one's artifact answers for the other.
    const key = `${output}:${contentHash}`;
    const existing = byHash.get(key);
    if (existing) existing.positions.push(position);
    else {
      byHash.set(key, {
        absPath: source.absPath,
        output,
        displayPath: source.displayPath ?? source.absPath,
        contentHash,
        positions: [position],
      });
    }
  }

  const work = [...byHash.values()];
  // One converter process writes one target format (`convertTargetFor`), so a
  // batch holds documents of one target only.
  const batches: WorkItem[][] = [];
  for (const output of new Set(work.map((item) => item.output))) {
    const sameTarget = work.filter((item) => item.output === output);
    for (let start = 0; start < sameTarget.length; start += batchSize) {
      batches.push(sameTarget.slice(start, start + batchSize));
    }
  }
  let processed = 0;

  for (const batch of batches) {
    const results = await convertBatch(batch, {
      store,
      runConverter,
      createStagingDir,
      removeStagingDir,
      discardScratch,
      prepareSource,
      countPdfWords,
      countSourceWords,
      epsilon,
      statfs: readSpace,
    });

    for (const [i, item] of batch.entries()) {
      for (const position of item.positions) {
        const { reason } = results[i];
        outcomes[position] = {
          ...results[i],
          sourcePath: sources[position].absPath,
          ...(reason === undefined
            ? {}
            : { reason: inOwnName(reason, item.absPath, sources[position].displayPath) }),
        };
      }
    }

    processed += batch.length;
    await options.onProgress?.({ processed, total: work.length });
  }

  return outcomes;
}

/**
 * Who converts, decided per call so a test can switch it.
 *
 * `KB_OFFICE_SPOOL_DIR` set — and Dockerfile.pinchy sets it, so every
 * production image does — means the office-converter sidecar: a container with
 * no network and no secrets (./office-converter-sidecar.ts). There is
 * deliberately NO fallback to converting in this process when the sidecar is
 * missing: that fallback would be exactly the capability the sidecar exists to
 * remove. A missing sidecar is an `infrastructure` outcome, retryable, with a
 * reason that says what to start.
 *
 * Unset — a developer machine running `pnpm dev`, the tests — means
 * LibreOffice in this process, staged inside the store.
 */
function defaultConverter(store: OfficeArtifactStore): {
  runConverter: RunConverter;
  createStagingDir: () => Promise<string>;
  removeStagingDir: (dir: string) => Promise<void>;
  discardScratch: (tmpDir: string) => Promise<void>;
} {
  const spoolDir = process.env.KB_OFFICE_SPOOL_DIR;
  if (spoolDir) return sidecarConverter(spoolDir);
  return {
    runConverter: runSoffice,
    createStagingDir: () => store.createStagingDir(),
    // In-process, everything in the batch is this process's own.
    removeStagingDir: removeTree,
    discardScratch: removeTree,
  };
}

function removeTree(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}

interface BatchDeps {
  store: OfficeArtifactStore;
  runConverter: RunConverter;
  createStagingDir: () => Promise<string>;
  removeStagingDir: (dir: string) => Promise<void>;
  /** Frees a killed run's scratch space; the sidecar's converter frees its own. */
  discardScratch: (tmpDir: string) => Promise<void>;
  prepareSource: PrepareSource;
  countPdfWords: (absPath: string) => Promise<number>;
  countSourceWords: (absPath: string, displayPath: string) => Promise<number | null>;
  epsilon: number;
  statfs: (dir: string) => Promise<VolumeSpace>;
}

/** The production preparer: the preflight, in the reader child. */
const defaultPrepareSource: PrepareSource = (absPath, staged) =>
  stageOfficeSourceIsolated(absPath, staged);

/**
 * Converts one batch in a single converter process.
 *
 * Inputs are STAGED under index names (`0.doc`, `1.pptx`, …) in a scratch
 * directory — as a private copy of the bytes the preflight checked (the file
 * sits on a share its planter can still write to, so converting a link would
 * convert whatever it holds by then) — and the naming is not cosmetic. LibreOffice derives the output
 * name from the input's basename, so two documents called `Rechnung.doc` in
 * different folders — the normal state of a real corpus — would write the same
 * `Rechnung.pdf` and one document would end up serving the other's text.
 * Index names make the input→output mapping positional and unambiguous, and
 * sidestep every quoting question a corpus filename can raise. Verified
 * against the real binary: the output follows the staged name, symlink or not.
 */
async function convertBatch(batch: WorkItem[], deps: BatchDeps): Promise<ConversionOutcome[]> {
  let stagingDir: string;
  try {
    stagingDir = await deps.createStagingDir();
  } catch (err) {
    // A full or unwritable staging volume (the artifact store's, or the
    // sidecar's spool) is a squeeze on the machine, not a verdict on these
    // documents — and it must arrive as a retryable outcome rather than an
    // exception that also throws away the batches that already succeeded.
    return batch.map((item) =>
      infrastructureFailure(item.absPath, `staging area unavailable: ${reasonOf(err)}`)
    );
  }
  /** Batches of a document's own run (see `runIsolatingKills`), removed with this one. */
  const ownBatches: string[] = [];

  const inDir = join(stagingDir, "in");
  const outDir = join(stagingDir, "out");
  const profileDir = join(stagingDir, "profile");
  const tmpDir = join(stagingDir, "tmp");
  /** Every document in a batch shares its target (see `convertOfficeFiles`). */
  const output = batch[0].output;

  try {
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });

    const outcomes = new Array<ConversionOutcome>(batch.length);
    /** Batch position -> its staged copy, for every document that reached the converter. */
    const inputs = new Map<number, string>();
    /** What each document is stored under: the hash of the bytes the preflight actually read. */
    const keys = batch.map((item) => item.contentHash);
    /** What each staged package unpacks to; null for one that is not an archive, or not known. */
    const unpacked = batch.map((): number | null => null);

    for (const [i, item] of batch.entries()) {
      const staged = join(inDir, `${i}${extname(item.absPath).toLowerCase()}`);
      try {
        // One file at a time, in the reader child: it reads, checks and
        // writes the copy at `staged`, and this process gets the metadata.
        const prepared = await deps.prepareSource(item.absPath, staged);
        if (prepared) {
          if (prepared.altChunksRemoved > 0) {
            // Unlike a cut picture link, a cut altChunk costs text: the
            // chunk's content (HTML, a nested document) is not indexed.
            console.warn(
              `[kb-office] ${oneLine(item.displayPath, LOG_PATH_MAX)}: cut ${prepared.altChunksRemoved} altChunk(s) — content embedded in another format is not indexed`
            );
          }
          // NOT the hash from the run's first read of the file: that read and
          // this one can see different bytes, and the artifact must be filed
          // under the content it was converted from.
          keys[i] = prepared.contentHash;
          unpacked[i] = prepared.unpackedBytes;
        } else await symlink(item.absPath, staged);
        inputs.set(i, staged);
      } catch (err) {
        if (err instanceof OfficeFileRejectedError) {
          outcomes[i] = documentFailure(item.absPath, `refused before conversion: ${err.message}`);
        } else if (err instanceof SheetReaderStoppedError) {
          // The child stopped without a verdict — killed by the system, out
          // of time, never started. Nothing is known about this document:
          // read it again next run, and keep what the index has meanwhile.
          outcomes[i] = infrastructureFailure(
            item.absPath,
            `could not check the source: ${err.message}`
          );
        } else if (err instanceof StagedCopyWriteError) {
          // The source was read and checked; only the volume refused the
          // copy — full, read-only, failing. Like a staging directory that
          // cannot be created, that is the machine, not this document.
          outcomes[i] = infrastructureFailure(
            item.absPath,
            `could not write the staged copy: ${err.message}`
          );
        } else {
          outcomes[i] = documentFailure(item.absPath, `could not stage source: ${reasonOf(err)}`);
        }
      }
    }

    if (inputs.size > 0) {
      let runs: Map<number, DocumentRun>;
      try {
        runs = await runIsolatingKills(
          inputs,
          { outDir, profileDir, tmpDir },
          output,
          deps,
          ownBatches
        );
      } catch (err) {
        // The converter could not be started at all (a missing binary, a
        // permission problem). Nothing here says anything about the documents.
        return batch.map(
          (item, i) =>
            outcomes[i] ??
            infrastructureFailure(item.absPath, `converter did not run: ${reasonOf(err)}`)
        );
      }

      for (const [i, run] of runs) {
        if ("error" in run) {
          // This document's own run could not be had — refused, or the
          // converter went away under it. About that run, not its batch-mates.
          outcomes[i] = infrastructureFailure(
            batch[i].absPath,
            `converter did not run: ${run.error}`
          );
          continue;
        }
        const { result } = run;
        if (!wasKilled(result)) continue;
        const reason = result.leftovers
          ? "the converter left a process running after this document — it restarts"
          : result.timedOut
            ? "converter exceeded its time budget"
            : "converter was killed — out of memory (see OFFICE_CONVERTER_MEM_LIMIT)";
        outcomes[i] = infrastructureFailure(batch[i].absPath, reason);
      }

      let probe: Promise<string | null> | undefined;
      let space: Promise<VolumeSpace | string> | undefined;
      for (const [i, item] of batch.entries()) {
        if (outcomes[i]) continue;
        const stagedSource = join(inDir, `${i}${extname(item.absPath).toLowerCase()}`);
        const run = runs.get(i) as RunAnswer;
        const producedPdf = join(run.outDir, `${i}${output}`);
        const outcome = await collectOne(
          { ...item, contentHash: keys[i] },
          stagedSource,
          producedPdf,
          deps,
          run.result.stderr
        );
        // Every document verdict collectOne gives is drawn from the PDF — and
        // both the PDF and LibreOffice's scratch land on the artifact volume
        // the staged copies just filled. Before a missing or broken PDF is
        // held against the document, rule out the volume: does the directory
        // still take a write, and is there room left to load this document
        // and write its PDF? Asked of the volume itself, once per batch:
        // LibreOffice's stderr cannot answer it (see `failedStoreLine`).
        const volumeFault =
          outcome.status === "failed"
            ? ((await (probe ??= probeWritable(outDir))) ??
              outputVolumeFault(
                await (space ??= readVolumeSpace(outDir, deps.statfs)),
                await stat(stagedSource).then(
                  (info) => info.size,
                  () => 0
                ),
                unpacked[i]
              ))
            : null;
        const storeLine = volumeFault ? failedStoreLine(run.result.stderr, producedPdf) : null;
        outcomes[i] = volumeFault
          ? infrastructureFailure(
              item.absPath,
              `could not write the converted ${output === ".xlsx" ? "workbook" : "PDF"}: ${volumeFault}${storeLine ? ` (converter: ${storeLine})` : ""}`
            )
          : outcome;
      }
    }

    return outcomes;
  } finally {
    // The converter owns what it wrote into a batch. Should it leave
    // something this process cannot (or, in the spool, will not) remove,
    // that costs a leftover, not the batch's results.
    for (const dir of [...ownBatches, stagingDir]) {
      await deps.removeStagingDir(dir).catch((err: unknown) => {
        console.warn(
          `[kb-office] could not remove the staged batch ${oneLine(dir, LOG_PATH_MAX)}: ${oneLine(reasonOf(err), LOG_REASON_MAX)}`
        );
      });
    }
  }
}

/** The run that speaks for one document, and where it wrote. */
interface RunAnswer {
  result: ConverterResult;
  outDir: string;
}

/** That, or why a document's own run could not be had at all. */
type DocumentRun = RunAnswer | { error: string };

/**
 * Runs the converter over a batch's staged inputs and answers, per batch
 * position, with the run that speaks for that document.
 *
 * Normally that is the batch's one run. But a run that was killed — the OOM
 * killer, or our own time budget — says nothing about which of its documents
 * was the cause, and a batch is a fixed slice of a sorted queue: the same
 * documents meet in the same batch every night. Booking the kill against all
 * of them would let one deck that takes LibreOffice down, or twenty large ones
 * that outlast the budget together, keep up to nineteen unrelated documents
 * from ever being converted. So a killed batch of more than one document is
 * run again one document at a time, and each document is answered by its own
 * run.
 *
 * Bounded: each document gets exactly one run of its own, on a budget of
 * `batchTimeoutMs(1)`, never a retry loop. One that dies alone is answered by
 * that kill — infrastructure, retried on the next reindex like any other kill,
 * because a document the container is too small for is the machine's to fix
 * (see `ConversionStatus`).
 *
 * Each run of its own is a batch of its own: a fresh staging directory from
 * `createStagingDir`, holding the document's staged copy again, with a fresh
 * profile, scratch space and output directory. So nothing the killed process
 * left behind — its profile mid-write, its scratch, a half-written PDF — is
 * reused or collected, and nothing of it has to be removed first. With the
 * sidecar that is also the only shape the converter accepts (it derives every
 * path from the batch), and the converter cleans up what it wrote; the
 * directories are removed with the batch, in `convertBatch`, the way any
 * batch is.
 */
async function runIsolatingKills(
  inputs: ReadonlyMap<number, string>,
  dirs: { outDir: string; profileDir: string; tmpDir: string },
  output: ConvertedExtension,
  deps: BatchDeps,
  ownBatches: string[]
): Promise<Map<number, DocumentRun>> {
  const batchRun = await deps.runConverter({
    inputs: [...inputs.values()],
    outDir: dirs.outDir,
    profileDir: dirs.profileDir,
    tmpDir: dirs.tmpDir,
    timeoutMs: batchTimeoutMs(inputs.size),
  });
  const runs = new Map<number, DocumentRun>();
  if (!wasKilled(batchRun) || inputs.size === 1) {
    for (const i of inputs.keys()) runs.set(i, { result: batchRun, outDir: dirs.outDir });
    return runs;
  }

  // What the dead process wrote — PDFs it got to, the last one possibly half
  // written, and its scratch — is on the volume the runs below and the
  // free-space check use; it goes first. Unlinked by name: nothing here
  // walks into a directory the converter made.
  for (const i of inputs.keys()) {
    await unlink(join(dirs.outDir, `${i}${output}`)).catch(() => {});
  }
  await deps.discardScratch(dirs.tmpDir).catch(() => {});

  for (const [i, staged] of inputs) {
    try {
      runs.set(i, await runAlone(staged, deps, ownBatches));
    } catch (err) {
      runs.set(i, { error: reasonOf(err) });
    }
  }
  return runs;
}

/** One document's run of its own, in a batch of its own (see `runIsolatingKills`). */
async function runAlone(staged: string, deps: BatchDeps, ownBatches: string[]): Promise<RunAnswer> {
  const own = await deps.createStagingDir();
  ownBatches.push(own);
  const ownDirs = {
    inDir: join(own, "in"),
    outDir: join(own, "out"),
    profileDir: join(own, "profile"),
    tmpDir: join(own, "tmp"),
  };
  for (const dir of Object.values(ownDirs)) await mkdir(dir, { recursive: true });
  const ownStaged = join(ownDirs.inDir, basename(staged));
  await restage(staged, ownStaged);
  return {
    result: await deps.runConverter({
      inputs: [ownStaged],
      outDir: ownDirs.outDir,
      profileDir: ownDirs.profileDir,
      tmpDir: ownDirs.tmpDir,
      timeoutMs: batchTimeoutMs(1),
    }),
    outDir: ownDirs.outDir,
  };
}

/**
 * Gives a document's run of its own the copy that was staged for the batch:
 * a copy by a hard link to it — the same checked bytes, the same `0640`
 * file this process owns, and nothing written twice (a killed batch is the
 * large one, and a second copy of each of its files would double what it
 * holds on the volume) — and a link, what the tests that fake the converter
 * stage, as a link to the same file. A volume that takes no hard link gets
 * a copy, exclusive and `0640` like the first.
 */
async function restage(staged: string, dest: string): Promise<void> {
  if ((await lstat(staged)).isSymbolicLink()) {
    await symlink(await readlink(staged), dest);
    return;
  }
  try {
    await link(staged, dest);
  } catch {
    await copyFile(staged, dest, fsConstants.COPYFILE_EXCL);
    await chmod(dest, 0o640);
  }
}

/**
 * Turns one staged output into an outcome: does the artifact exist, does it
 * clear the lower bound, and only then does it enter the store.
 */
async function collectOne(
  item: WorkItem,
  stagedSource: string,
  producedPdf: string,
  deps: BatchDeps,
  stderr: string
): Promise<ConversionOutcome> {
  let privateDir: string;
  try {
    privateDir = await deps.store.createStagingDir();
  } catch (err) {
    return infrastructureFailure(item.absPath, `artifact store unavailable: ${reasonOf(err)}`);
  }
  try {
    let taken: Awaited<ReturnType<typeof takeOutput>>;
    try {
      taken = await takeOutput(producedPdf, join(privateDir, `converted${item.output}`));
    } catch (err) {
      // About this output, not the document: retry it rather than brand it
      // unreadable, and keep the rest of the batch.
      return infrastructureFailure(
        item.absPath,
        `could not read the converter's output: ${reasonOf(err)}`
      );
    }
    if (taken === "missing") {
      // THE failure the exit code hides. stderr is the only place LibreOffice
      // says anything, so carry a trimmed copy for the operator log.
      return documentFailure(item.absPath, `no artifact produced${summarise(stderr)}`);
    }
    if (taken === "not-a-file") {
      return documentFailure(item.absPath, "converter output is not a regular file");
    }
    return await verifyAndCommit(item, stagedSource, taken, deps);
  } finally {
    await rm(privateDir, { recursive: true, force: true });
  }
}

/**
 * Copies the converter's output into a directory only this process writes,
 * and hands back that copy. The output directory is shared with the
 * converter, so its entry is opened without following links and without
 * waiting (a FIFO would block a plain open until something writes to it), and
 * taken only if it is a non-empty regular file; everything after this reads
 * the copy.
 */
async function takeOutput(
  producedPdf: string,
  privatePath: string
): Promise<string | "missing" | "not-a-file"> {
  let handle;
  try {
    handle = await open(
      producedPdf,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "ELOOP") return "not-a-file";
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "not-a-file";
    if (info.size === 0) return "missing";
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(privatePath, { flags: "wx" })
    );
    return privatePath;
  } finally {
    await handle.close();
  }
}

async function verifyAndCommit(
  item: WorkItem,
  stagedSource: string,
  producedPdf: string,
  deps: BatchDeps
): Promise<ConversionOutcome> {
  if (item.output === ".xlsx") return commitWorkbook(item, producedPdf, deps);

  let pdfWords: number;
  try {
    pdfWords = await deps.countPdfWords(producedPdf);
  } catch (err) {
    return documentFailure(item.absPath, `converted PDF is unreadable: ${reasonOf(err)}`);
  }

  // An oracle that breaks says nothing about the conversion, so it must never
  // fail a document — it only removes the tripwire for this one file. It reads
  // the STAGED copy: the bytes that were checked and converted, not whatever
  // the share holds by now.
  const sourceWords = await deps.countSourceWords(stagedSource, item.displayPath).catch(() => null);

  const verification: VerificationReport = {
    status: sourceWords === null ? "unverified" : "ok",
    sourceWords,
    pdfWords,
    epsilon: deps.epsilon,
  };

  if (sourceWords !== null && pdfWords < sourceWords * (1 - deps.epsilon)) {
    return {
      ...documentFailure(
        item.absPath,
        `conversion lost content: ${pdfWords} words in the PDF vs ${sourceWords} in the source`
      ),
      verification: { ...verification, status: "short" },
    };
  }

  let artifactPath: string;
  try {
    artifactPath = await deps.store.put(item.contentHash, producedPdf);
  } catch (err) {
    // The conversion itself succeeded and passed verification; only the volume
    // refused it. Retrying costs a conversion, but calling this document
    // unreadable would be a lie that nothing ever revisits.
    return infrastructureFailure(item.absPath, `artifact store rejected the PDF: ${reasonOf(err)}`);
  }

  return { sourcePath: item.absPath, status: "converted", artifactPath, verification };
}

/**
 * Stores a legacy workbook's conversion (#1373), deliberately unverified.
 *
 * The word-count tripwire compares a converted PDF against an independent
 * extractor; a workbook has no PDF, and the spreadsheet reader that would
 * count it skips the hidden sheets, rows and columns the source still holds,
 * so a count would fail on exactly the files it should pass. What reads the
 * workbook next is the isolated spreadsheet reader, with the same limits as
 * any `.xlsx`: an output it cannot open fails there, as that document's.
 */
async function commitWorkbook(
  item: WorkItem,
  producedWorkbook: string,
  deps: BatchDeps
): Promise<ConversionOutcome> {
  let artifactPath: string;
  try {
    artifactPath = await deps.store.put(item.contentHash, producedWorkbook, ".xlsx");
  } catch (err) {
    return infrastructureFailure(
      item.absPath,
      `artifact store rejected the workbook: ${reasonOf(err)}`
    );
  }
  return {
    sourcePath: item.absPath,
    status: "converted",
    artifactPath,
    verification: {
      status: "unverified",
      sourceWords: null,
      pdfWords: null,
      epsilon: deps.epsilon,
    },
  };
}

/**
 * LibreOffice's line saying it could not store `producedPdf`, or null —
 * corroboration for the operator log, never a verdict.
 *
 * A failed write of the output is reported, per file, as
 * `SfxBaseModel::impl_store <file:///…/out/<i>.pdf> failed: 0x…(Error Area:Io …)`
 * — exit 0, no PDF. Measured against the runtime image's LibreOffice 7.4: a
 * full tmpfs gives `Class:Access`, one with 4 KB left `Class:Space`, a target
 * answering ENOSPC `Class:Abort`. But the same line comes out when the export
 * fails for the DOCUMENT's sake: a .pptx whose every slide is hidden gives
 * `Class:Write Code:16` on a disk with gigabytes free. Taken as "the volume is
 * full", that deck would be converted again every run, never listed
 * unsearchable, and the operator sent after a disk that is fine. So the
 * volume decides (`probeWritable`, `outputVolumeFault`), and this line is only
 * quoted once it has. It is matched to the output it names — stderr is
 * batch-wide.
 */
function failedStoreLine(stderr: string, producedPdf: string): string | null {
  for (const line of stderr.split("\n")) {
    const match = /impl_store <(file:[^>]+)> failed:.*Error Area:Io/.exec(line);
    if (!match) continue;
    let target: string;
    try {
      target = fileURLToPath(match[1]);
    } catch {
      continue;
    }
    // By name: this stderr is the batch's own process, which writes into one
    // directory, and the path it prints may be one the OS resolved (macOS's
    // /var -> /private/var).
    if (basename(target) === basename(producedPdf)) return line.trim().slice(0, 300);
  }
  return null;
}

/**
 * Null when `dir` still takes a write, else why not.
 *
 * Writes, fsyncs and removes a small file: an fsync is where a quota or a
 * failing disk speaks up, not the open. The directory is the batch's own
 * scratch space, so a failure here says nothing about any document — whatever
 * the errno, it is the volume.
 */
async function probeWritable(dir: string): Promise<string | null> {
  const probe = join(dir, ".write-probe");
  try {
    const handle = await open(probe, "wx", 0o600);
    try {
      await handle.write(Buffer.alloc(4096));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await unlink(probe);
    return null;
  } catch (err) {
    await rm(probe, { force: true }).catch(() => {});
    return `output directory does not take a write: ${reasonOf(err)}`;
  }
}

/** What `statfs` says about `dir`'s volume, or why it said nothing. */
function readVolumeSpace(
  dir: string,
  statfs: (dir: string) => Promise<VolumeSpace>
): Promise<VolumeSpace | string> {
  return statfs(dir).catch(
    (err: unknown) => `output volume did not report its free space: ${reasonOf(err)}`
  );
}

/**
 * Null when the volume had room to load a document of `sourceBytes` that
 * unpacks to `unpackedBytes` and to write its PDF (see
 * `MIN_FREE_OUTPUT_BYTES`), else why not. `space` is what `statfs` said, or
 * why it said nothing — a volume that cannot report its own state is not one
 * to blame a document on.
 */
function outputVolumeFault(
  space: VolumeSpace | string,
  sourceBytes: number,
  unpackedBytes: number | null
): string | null {
  if (typeof space === "string") return space;
  const free = space.bavail * space.bsize;
  // The PDF's size, estimated, then twice: once in LibreOffice's TMPDIR, once in --outdir.
  const pdfBytes = Math.max(MIN_FREE_OUTPUT_BYTES, 2 * sourceBytes);
  const needed = (unpackedBytes ?? 0) + 2 * pdfBytes;
  if (free < needed) {
    return `only ${free} bytes free on the output volume, below the ${needed} bytes this document needs to load and convert`;
  }
  // 0 total inodes is a filesystem that does not count them (btrfs, some
  // network mounts), not one that ran out.
  if (space.files > 0 && space.ffree < MIN_FREE_OUTPUT_INODES) {
    return `only ${space.ffree} free inodes on the output volume`;
  }
  return null;
}

/**
 * Was the converter killed rather than finished? 137 is 128+9 — what a shell
 * or `docker` reports for SIGKILL — while a direct spawn sees the signal with
 * a null exit code. Both are the same event: the OOM killer, or our own
 * timeout.
 */
function wasKilled(result: ConverterResult): boolean {
  return (
    result.timedOut === true ||
    result.code === 137 ||
    result.signal === "SIGKILL" ||
    // Not a kill, but the same verdict on the run: it says nothing reliable
    // about any of its documents (office-converter-sidecar.ts).
    result.leftovers === true
  );
}

function documentFailure(sourcePath: string, reason: string): ConversionOutcome {
  return { sourcePath, status: "failed", reason };
}

function infrastructureFailure(sourcePath: string, reason: string): ConversionOutcome {
  return { sourcePath, status: "infrastructure", reason };
}

/**
 * `reason` with every mention of the private copy at `absPath` replaced by the
 * document's own name: a file system error quotes the path it was handed, and
 * the copy's reads like the document while being nowhere an admin can look.
 */
function inOwnName(reason: string, absPath: string, displayPath: string | undefined): string {
  return displayPath === undefined ? reason : reason.split(absPath).join(displayPath);
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Noise LibreOffice prints on EVERY run in our image and that says nothing
 * about any document. The JRE is deliberately absent (`--no-install-recommends`
 * in Dockerfile.pinchy keeps a whole Java runtime out of the image), so this
 * warning is permanent — and it is the FIRST stderr line, which is exactly why
 * "the first non-empty line" is the wrong excerpt to keep.
 */
const BENIGN_STDERR = /failed to launch javaldx/i;

/**
 * A short, single-line excerpt of converter stderr for the operator log.
 *
 * Prefers the line LibreOffice marks as an error, because stderr is batch-wide
 * — it names no file (verified against the real binary: the message is a bare
 * `Error: source file could not be loaded`) — and the interesting line is never
 * the first one. Attaching the javaldx warning to a failed document instead
 * sends an operator after a Java problem that does not exist.
 */
function summarise(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !BENIGN_STDERR.test(l));
  const line = lines.find((l) => /^error\b/i.test(l)) ?? lines[0];
  return line ? ` (converter stderr, batch-wide: ${line.slice(0, 200)})` : "";
}

// ---------------------------------------------------------------------------
// Production adapters (the converter itself lives in ./office-soffice.ts)
// ---------------------------------------------------------------------------

/** Words in the converted PDF, via the same pdfjs text layer the indexer reads. */
async function defaultCountPdfWords(absPath: string): Promise<number> {
  const pages = await extractPdfPages(absPath);
  return countWords(pages.map((page) => page.text).join(" "));
}

export interface OracleDeps {
  /**
   * Counts the words of the .docx at a path. Production reads it through the
   * guard and runs mammoth, both in the heap-capped reader child
   * (`countDocxWordsIsolated`), so this process never holds the file.
   */
  countDocxWords?: (absPath: string) => Promise<number>;
}

/**
 * Words the INDEPENDENT extractor sees in the original, or null when there is
 * none for this format.
 *
 * Independence is the point: an oracle derived from LibreOffice would agree
 * with LibreOffice about text it dropped, and verify nothing.
 *
 *   - `.docx` — mammoth, already a web dependency, reading OOXML directly —
 *     in the reader child (`xlsx-isolated.ts`), never in this process: its
 *     DOM costs up to ~300x the markup it parses.
 *   - `.doc`  — `catdoc`, and `.ppt` — `catppt` (Debian `catdoc`, ~1 MB next
 *     to LibreOffice's 422 MB). Both are known to under-report and to mangle
 *     Central/Eastern European diacritics; the lower-bound direction is chosen
 *     precisely so that costs nothing.
 *   - `.pptx` — no extractor available without adding a dependency, so it is
 *     honestly reported as unverified rather than silently passed.
 *
 * A missing binary is not an error: it yields null, the file is recorded
 * `unverified`, and conversion proceeds. Local dev has no catdoc.
 *
 * `displayPath` is what its log line calls the document: the conversion hands
 * the oracle a staged copy (`in/0.docx`), a name that says nothing.
 */
export async function countSourceWordsWithOracle(
  absPath: string,
  deps: OracleDeps = {},
  displayPath: string = absPath
): Promise<number | null> {
  const ext = extname(absPath).toLowerCase();

  if (ext === ".docx") {
    try {
      // The child reads the file through the same limits the conversion
      // input passed — mammoth inflates the whole archive, so a bomb must not
      // reach it through the oracle's door — and its heap cap bounds the
      // memory whatever those limits miss.
      return await (deps.countDocxWords ?? countDocxWordsIsolated)(absPath);
    } catch (err) {
      if (err instanceof OfficeFileRejectedError && err.code === "too_large") {
        // Too much markup for mammoth's DOM — refused by the scan, or by the
        // reader child running out of heap — or a bomb the conversion's own
        // preflight refuses as well. Not a failure: the conversion goes on,
        // without its tripwire.
        console.warn(
          `[kb-convert] ${oneLine(displayPath, LOG_PATH_MAX)}: word count skipped, unverified — ${oneLine(err.message, LOG_REASON_MAX)}`
        );
      }
      return null;
    }
  }

  if (ext === ".doc") return runTextOracle("catdoc", absPath);
  if (ext === ".ppt") return runTextOracle("catppt", absPath);
  return null;
}

/**
 * Text an oracle may produce before we stop believing it. 16 MB is roughly 2.5
 * million words — orders of magnitude past any document, and small enough that
 * a `.doc` crafted to make catdoc emit without end cannot take the web process
 * down with it. The oracle is a tripwire; it is not worth a single OOM.
 */
const MAX_ORACLE_BYTES = 16 * 1024 * 1024;

/**
 * Runs a text-dumping CLI over `absPath` and counts its words; null if it is
 * absent, unhappy, too slow, or too talkative.
 *
 * Exported for the adapter test — the production callers pass a fixed binary
 * name, so this is the only seam a stub can reach.
 */
export function runTextOracle(bin: string, absPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, [absPath], {
      stdio: ["ignore", "pipe", "ignore"],
      env: childEnv(process.env.HOME ?? "/tmp"),
      detached: true,
    });
    let out = "";
    let settled = false;
    const finish = (words: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(words);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > MAX_ORACLE_BYTES) {
        killTree(child);
        finish(null);
      }
    });
    const timer = setTimeout(() => {
      killTree(child);
      finish(null);
    }, 30_000);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? countWords(out) : null));
  });
}

export { countWords };

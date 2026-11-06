/**
 * Converts page-shaped Office documents (.doc/.docx/.ppt/.pptx) to PDF for the
 * knowledge base (#936). Standalone: wiring this into the ingest pipeline is
 * #938's job, and serving the artifact as a preview is #939's.
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
 * never point at something the user cannot see. Spreadsheets take a different
 * path (#937/#940) — `libreoffice-calc` is deliberately not installed.
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
import type { StatsFs } from "node:fs";
import { mkdir, open, rm, stat, statfs, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_PATH_MAX, LOG_REASON_MAX, oneLine } from "../log-line";

import { getOfficeArtifactStore, hashFileContents, OfficeArtifactStore } from "./office-artifacts";
import {
  countWords,
  OFFICE_CONVERT_BATCH_SIZE,
  OFFICE_EXTENSIONS,
  OfficeFileRejectedError,
  StagedCopyWriteError,
  isOfficeFile,
} from "./office-formats";
import type { StagedSource } from "./office-preflight";
import { extractPdfPages } from "./pdf-extract";
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
  /** Set for `converted` only. */
  verification?: VerificationReport;
  /**
   * Diagnostic. Holds no document text, but it can quote names read from the
   * file (a part's, an entry's — escaped and cut short where they are quoted)
   * and the file system's own words, which may name the source path. A log
   * line built from it must still keep it to one line.
   */
  reason?: string;
}

export interface ConverterRun {
  /** Absolute paths of the staged inputs, in order. Their basenames are `<index>.<ext>`. */
  inputs: string[];
  /** Where the converter must write `<index>.pdf`. */
  outDir: string;
  /** A private LibreOffice profile, so concurrent runs never fight over one user installation. */
  profileDir: string;
  /**
   * The converter's scratch space (`TMPDIR`), inside the batch — on the volume
   * the free-space check asks, and removed with the batch.
   */
  tmpDir: string;
  timeoutMs: number;
}

export interface ConverterResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** True when WE killed it for taking too long — infrastructure, but not memory. */
  timedOut?: boolean;
}

export type RunConverter = (run: ConverterRun) => Promise<ConverterResult>;

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
  /** See `OfficeSource.displayPath`. */
  displayPath: string;
  contentHash: string;
  /** Every input position that shares this content — two paths, one conversion. */
  positions: number[];
}

/**
 * Converts `sources` to PDFs in the artifact store, returning one outcome per
 * source, in input order.
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
  const runConverter = options.runConverter ?? runSoffice;
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

    const cached = await store.get(contentHash);
    if (cached) {
      outcomes[position] = {
        sourcePath: source.absPath,
        status: "converted",
        artifactPath: cached,
        verification: { status: "cached", sourceWords: null, pdfWords: null, epsilon },
      };
      continue;
    }

    const existing = byHash.get(contentHash);
    if (existing) existing.positions.push(position);
    else {
      byHash.set(contentHash, {
        absPath: source.absPath,
        displayPath: source.displayPath ?? source.absPath,
        contentHash,
        positions: [position],
      });
    }
  }

  const work = [...byHash.values()];
  let processed = 0;

  for (let start = 0; start < work.length; start += batchSize) {
    const batch = work.slice(start, start + batchSize);
    const results = await convertBatch(batch, {
      store,
      runConverter,
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

interface BatchDeps {
  store: OfficeArtifactStore;
  runConverter: RunConverter;
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
    stagingDir = await deps.store.createStagingDir();
  } catch (err) {
    // A full or unwritable artifact volume is a squeeze on the machine, not a
    // verdict on these documents — and it must arrive as a retryable outcome
    // rather than an exception that also throws away the batches that already
    // succeeded.
    return batch.map((item) =>
      infrastructureFailure(item.absPath, `artifact store unavailable: ${reasonOf(err)}`)
    );
  }

  const inDir = join(stagingDir, "in");
  const outDir = join(stagingDir, "out");
  const profileDir = join(stagingDir, "profile");
  const tmpDir = join(stagingDir, "tmp");

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
      let runs: Map<number, ConverterResult>;
      try {
        runs = await runIsolatingKills(inputs, { stagingDir, outDir, profileDir, tmpDir }, deps);
      } catch (err) {
        // The converter could not be started at all (a missing binary, a
        // permission problem). Nothing here says anything about the documents.
        return batch.map(
          (item, i) =>
            outcomes[i] ??
            infrastructureFailure(item.absPath, `converter did not run: ${reasonOf(err)}`)
        );
      }

      for (const [i, result] of runs) {
        if (!wasKilled(result)) continue;
        const reason = result.timedOut
          ? "converter exceeded its time budget"
          : "converter was killed — out of memory (see PINCHY_MEM_LIMIT)";
        outcomes[i] = infrastructureFailure(batch[i].absPath, reason);
      }

      let probe: Promise<string | null> | undefined;
      let space: Promise<VolumeSpace | string> | undefined;
      for (const [i, item] of batch.entries()) {
        if (outcomes[i]) continue;
        const stagedSource = join(inDir, `${i}${extname(item.absPath).toLowerCase()}`);
        const producedPdf = join(outDir, `${i}.pdf`);
        const outcome = await collectOne(
          { ...item, contentHash: keys[i] },
          stagedSource,
          producedPdf,
          deps,
          runs.get(i)!.stderr
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
        const storeLine = volumeFault ? failedStoreLine(runs.get(i)!.stderr, producedPdf) : null;
        outcomes[i] = volumeFault
          ? infrastructureFailure(
              item.absPath,
              `could not write the converted PDF: ${volumeFault}${storeLine ? ` (converter: ${storeLine})` : ""}`
            )
          : outcome;
      }
    }

    return outcomes;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

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
 * (see `ConversionStatus`). Each run of its own gets a fresh profile and
 * scratch space: the killed process left its own behind mid-write, and the
 * PDFs it may have half written are removed before they could be collected.
 */
async function runIsolatingKills(
  inputs: ReadonlyMap<number, string>,
  dirs: { stagingDir: string; outDir: string; profileDir: string; tmpDir: string },
  deps: BatchDeps
): Promise<Map<number, ConverterResult>> {
  const batchRun = await deps.runConverter({
    inputs: [...inputs.values()],
    outDir: dirs.outDir,
    profileDir: dirs.profileDir,
    tmpDir: dirs.tmpDir,
    timeoutMs: batchTimeoutMs(inputs.size),
  });
  const runs = new Map<number, ConverterResult>();
  if (!wasKilled(batchRun) || inputs.size === 1) {
    for (const i of inputs.keys()) runs.set(i, batchRun);
    return runs;
  }

  // What the dead process held on the volume — its scratch, and whatever
  // PDFs it got to, the last one possibly half written — goes first.
  await rm(dirs.tmpDir, { recursive: true, force: true });
  for (const i of inputs.keys()) await rm(join(dirs.outDir, `${i}.pdf`), { force: true });

  for (const [i, staged] of inputs) {
    const own = join(dirs.stagingDir, `alone-${i}`);
    const profileDir = join(own, "profile");
    const tmpDir = join(own, "tmp");
    await mkdir(profileDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    try {
      runs.set(
        i,
        await deps.runConverter({
          inputs: [staged],
          outDir: dirs.outDir,
          profileDir,
          tmpDir,
          timeoutMs: batchTimeoutMs(1),
        })
      );
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  }
  return runs;
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
  const info = await stat(producedPdf).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    // THE failure the exit code hides. stderr is the only place LibreOffice
    // says anything, so carry a trimmed copy for the operator log.
    return documentFailure(item.absPath, `no artifact produced${summarise(stderr)}`);
  }

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
    const handle = await open(probe, "wx");
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
  return result.timedOut === true || result.code === 137 || result.signal === "SIGKILL";
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
// Production adapters
// ---------------------------------------------------------------------------

/**
 * stderr we keep. LibreOffice repeats itself per file; a huge batch must not
 * build a huge string. But the per-file `impl_store … failed` line is what an
 * operator is shown for a PDF the full volume did not take (`failedStoreLine`
 * — the volume decides, the line only says what LibreOffice saw), so the cap
 * must hold a whole batch of them: at staging-path lengths a failed file
 * costs ~450 bytes (its `convert` line and its error), 20 of them ~9 KB.
 */
const MAX_STDERR_BYTES = 32 * 1024;

/**
 * What a converter subprocess inherits from us — an allow-list, not a copy of
 * `process.env`.
 *
 * Both subprocesses in this module parse documents the corpus owner did not
 * write, in formats (legacy `.doc`/`.ppt`) with a long history of
 * memory-safety bugs. Neither has any use for `DATABASE_URL`,
 * `ENCRYPTION_KEY` or `BETTER_AUTH_SECRET`, so neither gets them. Verified
 * against the real binary: `PATH` plus `HOME` is enough to convert, with the
 * Central/Eastern European diacritics the corpus is full of intact; the rest
 * are locale and timezone, which change how a document RENDERS and so are
 * passed through when the operator set them.
 */
const INHERITED_ENV = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ"] as const;

function childEnv(home: string, tmpDir?: string): NodeJS.ProcessEnv {
  // NODE_ENV carries no secret and is what every child process here already
  // sees; it is listed explicitly because Next.js declares it non-optional.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, HOME: home };
  if (tmpDir !== undefined) env.TMPDIR = tmpDir;
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * SIGKILLs a child AND everything it forked.
 *
 * `spawn` is given `detached: true` so the child leads its own process group,
 * and this kills the group. That is not belt-and-braces: `soffice` execs
 * `oosplash`, which **forks** `soffice.bin` — so killing the process we
 * spawned leaves the real converter running, still holding the memory the
 * timeout was meant to reclaim and still writing into a staging directory we
 * are about to delete. Verified in the runtime image, both directions: killing
 * the pid orphans `soffice.bin`, killing the group reaps it.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone, or the platform has no process groups.
    child.kill("SIGKILL");
  }
}

/**
 * The user-installation settings every conversion runs with, written as
 * `registrymodifications.xcu` into a profile that has never been used.
 *
 * The documents are untrusted, and LibreOffice, left to its defaults, will
 * fetch a linked picture over HTTP (an SSRF from a container that has a
 * network) and embed a `file://` one into the PDF (a local-file read that is
 * then served to every reader of the knowledge base). Each setting here was
 * chosen by CANARY — a crafted document, a local listener, the real binary —
 * not by its name (office-convert.libreoffice.test.ts keeps those canaries):
 *
 *   - `BlockUntrustedRefererLinks` stopped BOTH the http fetch and the
 *     `file://` embed on its own, for Word, PowerPoint, an HTML file posing as
 *     `.doc`, and flat ODF. It is the load-bearing line.
 *   - `Link = 2` (never update links on load) is the same intent, by the
 *     documented knob; on its own it did NOT stop the fetch.
 *   - A manual proxy at a closed port (nothing exempted) stopped the http
 *     fetch but not `file://`. Its job is the future: whatever LibreOffice
 *     learns to fetch next still has nowhere to go.
 *
 * Macros are pinned off as well: `MacroSecurityLevel = 3` (very high: only
 * macros from trusted file locations, and there are none) and
 * `DisableMacrosExecution = true` (disables Basic, Beanshell, JavaScript and
 * Python scripts outright; names and types as declared in officecfg
 * `Common.xcs`). Unlike the link settings these were NOT chosen by canary:
 * the shipped default is already level 2 (high, unsigned macros disabled), so
 * there is no behaviour to measure against. They are pinned so that a changed
 * default, or an override from a distro or a shared configuration, cannot
 * quietly turn macro execution on for untrusted documents.
 *
 * Two honest limits, both measured. This profile
 * does NOT stop LibreOffice's HTML import (an altChunk) or its SVG import from
 * reading `file://` references — and anything LibreOffice takes for SVG by its
 * bytes goes through that import, whatever the document called it: a picture,
 * a font, an RTF `\pict`, a picture inside an EMF+ record. For OOXML and RTF,
 * `office-preflight.ts` is a second layer — defence in depth with known
 * limits, not a guarantee: it cuts altChunks, pictures that reach outside
 * themselves (and every record of a metafile that can carry another) and
 * everything else not on its allow-list, and refuses what it cannot read
 * unambiguously. Each of those answers a vector found by canary; the next way
 * LibreOffice draws something by its bytes is a gap until it is found. For
 * the legacy binary formats (`.doc`, `.ppt`), which the preflight cannot
 * rewrite, this profile is the ONLY layer, and an SVG embedded in one still
 * reads a local file (the canary pins that gap). Isolating the converter
 * itself — no network, no view of the workspaces — is what closes the family;
 * that is separate work (branch feat/kb-office-convert-sidecar). The canary
 * says, vector by vector, which layers hold alone.
 *
 * The last setting is not about links: it pins LibreOffice's Temp path to
 * `$(temp)`, which is `TMPDIR` (see `runSoffice`). That is the default on
 * Linux, but a macOS build defaults to the profile's own `temp` directory
 * (measured, LibreOffice 26.2), so the scratch space would follow the build
 * rather than the batch's `tmpDir`.
 */
const LOCKED_DOWN_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${[
  ["/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", "true"],
  ["/org.openoffice.Office.Common/Security/Scripting", "MacroSecurityLevel", "3"],
  ["/org.openoffice.Office.Common/Security/Scripting", "DisableMacrosExecution", "true"],
  ["/org.openoffice.Office.Writer/Content/Update", "Link", "2"],
  ["/org.openoffice.Inet/Settings", "ooInetProxyType", "2"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPProxyName", "127.0.0.1"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPProxyPort", "9"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPSProxyName", "127.0.0.1"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPSProxyPort", "9"],
  ["/org.openoffice.Inet/Settings", "ooInetNoProxy", ""],
  [
    "/org.openoffice.Office.Paths/Paths/org.openoffice.Office.Paths:NamedPath['Temp']",
    "WritePath",
    "$(temp)",
  ],
]
  .map(
    ([path, name, value]) =>
      `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`
  )
  .join("\n")}
</oor:items>
`;

async function writeLockedDownProfile(profileDir: string): Promise<void> {
  const userDir = join(profileDir, "user");
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, "registrymodifications.xcu"), LOCKED_DOWN_PROFILE);
}

/**
 * The real converter: ONE `soffice` per batch.
 *
 * `-env:UserInstallation` (and a matching HOME) gives the process a private
 * profile inside the staging directory. Without it LibreOffice shares one user
 * installation, and a second instance — a concurrent reindex, or a leftover
 * process — refuses to start or silently reuses the other's state.
 *
 * `TMPDIR` puts its scratch space there too. LibreOffice unpacks a package
 * into it while loading — about the unpacked size — and left to itself uses
 * the container's /tmp, a volume no check here looks at: a load that runs out
 * of room there exits 0 with `source file could not be loaded`, which is what
 * an unreadable document says. In the batch it is on the volume
 * `outputVolumeFault` asks. Verified against the runtime image's
 * LibreOffice 7.4: with a 20 MiB /tmp and TMPDIR on a roomy volume, a
 * document needing 26 MB of scratch converts and /tmp stays empty. LibreOffice
 * finds TMPDIR through its Temp path setting, which the profile pins.
 *
 * The binary is resolved per call rather than at import so a test can point at
 * a stub: without that, everything below is only reachable on a machine with a
 * 422 MB LibreOffice installed, which is no machine CI runs on.
 */
export const runSoffice: RunConverter = async (run) => {
  // Before the process exists, and a failure here is a failure to convert: a
  // converter that cannot be locked down must not run at all.
  await writeLockedDownProfile(run.profileDir);
  return spawnSoffice(run);
};

const spawnSoffice: RunConverter = ({ inputs, outDir, profileDir, tmpDir, timeoutMs }) =>
  new Promise<ConverterResult>((resolve, reject) => {
    const child = spawn(
      process.env.KB_SOFFICE_BIN || "soffice",
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        `-env:UserInstallation=file://${profileDir}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        ...inputs,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: childEnv(profileDir, tmpDir), detached: true }
    );

    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_STDERR_BYTES);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, timedOut });
    });
  });

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

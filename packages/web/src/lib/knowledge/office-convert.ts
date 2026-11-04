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
 *    Batches are bounded (`DEFAULT_BATCH_SIZE`) so a single OOM kill costs a
 *    batch rather than the corpus.
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
 *    artifact means THIS document is unreadable — final. Without the split,
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
import { constants as fsConstants, createWriteStream } from "node:fs";
import { mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { extname, join } from "node:path";

import { getOfficeArtifactStore, hashFileContents, OfficeArtifactStore } from "./office-artifacts";
import {
  OFFICE_CONVERT_BATCH_SIZE,
  OFFICE_EXTENSIONS,
  OfficeFileRejectedError,
  isOfficeFile,
} from "./office-formats";
import { prepareOfficeSource, readGuardedDocx, type PreparedSource } from "./office-preflight";
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

export interface OfficeSource {
  absPath: string;
  /**
   * sha256 of the file's bytes — the artifact key. Optional because a
   * standalone caller may not have it; ingest already computes exactly this
   * for its own idempotency check and should pass it rather than pay for a
   * second read.
   */
  contentHash?: string;
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
  /** Diagnostic. Never carries document content — it is safe to log. */
  reason?: string;
}

export interface ConvertProgress {
  /** Documents whose conversion is behind us — including the ones that failed. */
  processed: number;
  /** Documents that actually need converting: cache hits are not counted, they are not work. */
  total: number;
}

/**
 * Vets one source and returns the bytes to convert — or `null` to convert the
 * file in place, through a link (what the tests that fake the converter use).
 * Throws `OfficeFileRejectedError` for a file that must not reach a reader.
 */
export type PrepareSource = (absPath: string) => Promise<PreparedSource | null>;

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
  /** Defaults to the real preflight (./office-preflight.ts). */
  prepareSource?: PrepareSource;
  /** Words in the converted PDF. Prod: the pdfjs text layer (./pdf-extract.ts). */
  countPdfWords?: (absPath: string) => Promise<number>;
  /** Words the INDEPENDENT extractor sees in the original, or null when there is none for this format. */
  countSourceWords?: (absPath: string) => Promise<number | null>;
  batchSize?: number;
  epsilon?: number;
  onProgress?: (progress: ConvertProgress) => void | Promise<void>;
}

/** One document's slot in the run, so results can be returned in input order. */
interface WorkItem {
  absPath: string;
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
  const converter = defaultConverter(store);
  const runConverter = options.runConverter ?? converter.runConverter;
  const createStagingDir = options.createStagingDir ?? converter.createStagingDir;
  const removeStagingDir =
    options.removeStagingDir ??
    (options.createStagingDir ? removeTree : converter.removeStagingDir);
  const prepareSource = options.prepareSource ?? prepareOfficeSource;
  const countPdfWords = options.countPdfWords ?? defaultCountPdfWords;
  const countSourceWords = options.countSourceWords ?? countSourceWordsWithOracle;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const epsilon = options.epsilon ?? OFFICE_VERIFY_EPSILON;

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
        outcomes[position] = documentFailure(source.absPath, `unreadable source: ${reasonOf(err)}`);
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
    else byHash.set(contentHash, { absPath: source.absPath, contentHash, positions: [position] });
  }

  const work = [...byHash.values()];
  let processed = 0;

  for (let start = 0; start < work.length; start += batchSize) {
    const batch = work.slice(start, start + batchSize);
    const results = await convertBatch(batch, {
      store,
      runConverter,
      createStagingDir,
      removeStagingDir,
      prepareSource,
      countPdfWords,
      countSourceWords,
      epsilon,
    });

    for (const [i, item] of batch.entries()) {
      for (const position of item.positions) {
        outcomes[position] = { ...results[i], sourcePath: sources[position].absPath };
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
 * LibreOffice in this process, staged inside the store as before.
 */
function defaultConverter(store: OfficeArtifactStore): {
  runConverter: RunConverter;
  createStagingDir: () => Promise<string>;
  removeStagingDir: (dir: string) => Promise<void>;
} {
  const spoolDir = process.env.KB_OFFICE_SPOOL_DIR;
  if (spoolDir) return sidecarConverter(spoolDir);
  return {
    runConverter: runSoffice,
    createStagingDir: () => store.createStagingDir(),
    // In-process, everything in the batch is this process's own.
    removeStagingDir: removeTree,
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
  prepareSource: PrepareSource;
  countPdfWords: (absPath: string) => Promise<number>;
  countSourceWords: (absPath: string) => Promise<number | null>;
  epsilon: number;
}

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
    // documents — and it must arrive as a retryable outcome
    // rather than an exception that also throws away the batches that already
    // succeeded.
    return batch.map((item) =>
      infrastructureFailure(item.absPath, `staging area unavailable: ${reasonOf(err)}`)
    );
  }

  const inDir = join(stagingDir, "in");
  const outDir = join(stagingDir, "out");
  const profileDir = join(stagingDir, "profile");

  try {
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const outcomes = new Array<ConversionOutcome>(batch.length);
    const inputs: string[] = [];
    /** What each document is stored under: the hash of the bytes the preflight actually read. */
    const keys = batch.map((item) => item.contentHash);

    for (const [i, item] of batch.entries()) {
      const staged = join(inDir, `${i}${extname(item.absPath).toLowerCase()}`);
      try {
        const prepared = await deps.prepareSource(item.absPath);
        if (prepared) {
          if (prepared.altChunksRemoved > 0) {
            // Unlike a cut picture link, a cut altChunk costs text: the
            // chunk's content (HTML, a nested document) is not indexed.
            console.warn(
              `[kb-office] ${item.absPath}: cut ${prepared.altChunksRemoved} altChunk(s) — content embedded in another format is not indexed`
            );
          }
          // Exclusive create: in the sidecar's spool another process may make
          // entries, and whatever already sits at this name is refused, never
          // written through.
          // An explicit mode: a umask can only remove bits, so the converter's
          // group can read the copy and, whatever the umask, never write it.
          await writeFile(staged, prepared.data, { flag: "wx", mode: 0o640 });
          // NOT the hash from the run's first read of the file: that read and
          // this one can see different bytes, and the artifact must be filed
          // under the content it was converted from.
          keys[i] = prepared.contentHash;
        } else await symlink(item.absPath, staged);
        inputs.push(staged);
      } catch (err) {
        outcomes[i] =
          err instanceof OfficeFileRejectedError
            ? documentFailure(item.absPath, `refused before conversion: ${err.message}`)
            : documentFailure(item.absPath, `could not stage source: ${reasonOf(err)}`);
      }
    }

    if (inputs.length > 0) {
      let result: ConverterResult;
      try {
        result = await deps.runConverter({
          inputs,
          outDir,
          profileDir,
          timeoutMs: batchTimeoutMs(inputs.length),
        });
      } catch (err) {
        // The converter could not be started at all (a missing binary, a
        // permission problem). Nothing here says anything about the documents.
        return batch.map(
          (item, i) =>
            outcomes[i] ??
            infrastructureFailure(item.absPath, `converter did not run: ${reasonOf(err)}`)
        );
      }

      if (wasKilled(result)) {
        const reason = result.timedOut
          ? "converter exceeded its time budget"
          : "converter was killed — out of memory (raise OFFICE_CONVERTER_MEM_LIMIT)";
        return batch.map((item, i) => outcomes[i] ?? infrastructureFailure(item.absPath, reason));
      }

      for (const [i, item] of batch.entries()) {
        if (outcomes[i]) continue;
        outcomes[i] = await collectOne(
          { ...item, contentHash: keys[i] },
          join(inDir, `${i}${extname(item.absPath).toLowerCase()}`),
          join(outDir, `${i}.pdf`),
          deps,
          result.stderr
        );
      }
    }

    return outcomes;
  } finally {
    // The converter owns what it wrote into the batch. Should it leave
    // something this process cannot (or, in the spool, will not) remove,
    // that costs a leftover, not the batch's results.
    await deps.removeStagingDir(stagingDir).catch((err: unknown) => {
      console.warn(`[kb-office] could not remove the staged batch ${stagingDir}: ${reasonOf(err)}`);
    });
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
    return infrastructureFailure(item.absPath, `staging area unavailable: ${reasonOf(err)}`);
  }
  try {
    let taken: Awaited<ReturnType<typeof takeOutput>>;
    try {
      taken = await takeOutput(producedPdf, join(privateDir, "converted.pdf"));
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
  const sourceWords = await deps.countSourceWords(stagedSource).catch(() => null);

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

/**
 * Words the INDEPENDENT extractor sees in the original, or null when there is
 * none for this format.
 *
 * Independence is the point: an oracle derived from LibreOffice would agree
 * with LibreOffice about text it dropped, and verify nothing.
 *
 *   - `.docx` — mammoth, already a web dependency, reading OOXML directly.
 *   - `.doc`  — `catdoc`, and `.ppt` — `catppt` (Debian `catdoc`, ~1 MB next
 *     to LibreOffice's 422 MB). Both are known to under-report and to mangle
 *     Central/Eastern European diacritics; the lower-bound direction is chosen
 *     precisely so that costs nothing.
 *   - `.pptx` — no extractor available without adding a dependency, so it is
 *     honestly reported as unverified rather than silently passed.
 *
 * A missing binary is not an error: it yields null, the file is recorded
 * `unverified`, and conversion proceeds. Local dev has no catdoc.
 */
export async function countSourceWordsWithOracle(absPath: string): Promise<number | null> {
  const ext = extname(absPath).toLowerCase();

  if (ext === ".docx") {
    try {
      // The same limits the conversion input passed: mammoth inflates the
      // whole archive, so a bomb must not reach it through the oracle's door.
      const buffer = await readGuardedDocx(absPath);
      const { default: mammoth } = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer });
      return countWords(value);
    } catch (err) {
      if (err instanceof OfficeFileRejectedError && err.code === "too_large") {
        // Too much for mammoth's DOM in this process (or a bomb the
        // conversion's own preflight refuses as well). Not a failure: the
        // conversion goes on, without its tripwire.
        console.warn(`[kb-convert] ${absPath}: word count skipped, unverified — ${err.message}`);
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

/** One word-splitting rule for both sides of the comparison — two rules would make the bound meaningless. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

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
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, symlink } from "node:fs/promises";
import { extname, join } from "node:path";

import { getOfficeArtifactStore, OfficeArtifactStore } from "./office-artifacts";
import { extractPdfPages } from "./pdf-extract";

/**
 * The page-shaped Office formats. Spreadsheets are deliberately absent: a
 * sheet is not a page, and rendering one to PDF produces arbitrary page breaks
 * that no citation can honestly point at (#937/#940).
 */
export const OFFICE_EXTENSIONS = [".doc", ".docx", ".ppt", ".pptx"] as const;

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
 * Files per converter process. Big enough that startup is amortised (the whole
 * 17-file reference corpus fits in one batch), small enough that an OOM kill —
 * which fails the WHOLE batch as infrastructure — costs a bounded amount of
 * re-work, and that progress is reported more than once on a large corpus.
 */
export const DEFAULT_BATCH_SIZE = 20;

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

export interface ConverterRun {
  /** Absolute paths of the staged inputs, in order. Their basenames are `<index>.<ext>`. */
  inputs: string[];
  /** Where the converter must write `<index>.pdf`. */
  outDir: string;
  /** A private LibreOffice profile, so concurrent runs never fight over one user installation. */
  profileDir: string;
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

export interface ConvertOptions {
  store?: OfficeArtifactStore;
  runConverter?: RunConverter;
  /** Words in the converted PDF. Prod: the pdfjs text layer (./pdf-extract.ts). */
  countPdfWords?: (absPath: string) => Promise<number>;
  /** Words the INDEPENDENT extractor sees in the original, or null when there is none for this format. */
  countSourceWords?: (absPath: string) => Promise<number | null>;
  batchSize?: number;
  epsilon?: number;
  onProgress?: (progress: ConvertProgress) => void | Promise<void>;
}

/** Is this a page-shaped Office document this module converts? */
export function isOfficeFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return (OFFICE_EXTENSIONS as readonly string[]).includes(ext);
}

/** sha256 of a file's bytes, streamed — the artifact-store key. */
export async function hashFileContents(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absPath)) hash.update(chunk);
  return hash.digest("hex");
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
  const runConverter = options.runConverter ?? runSoffice;
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

interface BatchDeps {
  store: OfficeArtifactStore;
  runConverter: RunConverter;
  countPdfWords: (absPath: string) => Promise<number>;
  countSourceWords: (absPath: string) => Promise<number | null>;
  epsilon: number;
}

/**
 * Converts one batch in a single converter process.
 *
 * Inputs are STAGED as index-named symlinks (`0.doc`, `1.pptx`, …) in a
 * scratch directory, and that is not cosmetic. LibreOffice derives the output
 * name from the input's basename, so two documents called `Rechnung.doc` in
 * different folders — the normal state of a real corpus — would write the same
 * `Rechnung.pdf` and one document would end up serving the other's text.
 * Index names make the input→output mapping positional and unambiguous, and
 * sidestep every quoting question a corpus filename can raise. Verified
 * against the real binary: the output follows the symlink's name, not the
 * target's.
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

  try {
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const outcomes = new Array<ConversionOutcome>(batch.length);
    const inputs: string[] = [];

    for (const [i, item] of batch.entries()) {
      const staged = join(inDir, `${i}${extname(item.absPath).toLowerCase()}`);
      try {
        await symlink(item.absPath, staged);
        inputs.push(staged);
      } catch (err) {
        outcomes[i] = documentFailure(item.absPath, `could not stage source: ${reasonOf(err)}`);
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
          : "converter was killed — out of memory (see PINCHY_MEM_LIMIT)";
        return batch.map((item, i) => outcomes[i] ?? infrastructureFailure(item.absPath, reason));
      }

      for (const [i, item] of batch.entries()) {
        if (outcomes[i]) continue;
        outcomes[i] = await collectOne(item, join(outDir, `${i}.pdf`), deps, result.stderr);
      }
    }

    return outcomes;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Turns one staged output into an outcome: does the artifact exist, does it
 * clear the lower bound, and only then does it enter the store.
 */
async function collectOne(
  item: WorkItem,
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
  // fail a document — it only removes the tripwire for this one file.
  const sourceWords = await deps.countSourceWords(item.absPath).catch(() => null);

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
// Production adapters
// ---------------------------------------------------------------------------

/** stderr we keep. LibreOffice repeats itself per file; a huge batch must not build a huge string. */
const MAX_STDERR_BYTES = 8 * 1024;

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

function childEnv(home: string): NodeJS.ProcessEnv {
  // NODE_ENV carries no secret and is what every child process here already
  // sees; it is listed explicitly because Next.js declares it non-optional.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, HOME: home };
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
 * The real converter: ONE `soffice` per batch.
 *
 * `-env:UserInstallation` (and a matching HOME) gives the process a private
 * profile inside the staging directory. Without it LibreOffice shares one user
 * installation, and a second instance — a concurrent reindex, or a leftover
 * process — refuses to start or silently reuses the other's state.
 *
 * The binary is resolved per call rather than at import so a test can point at
 * a stub: without that, everything below is only reachable on a machine with a
 * 422 MB LibreOffice installed, which is no machine CI runs on.
 */
export const runSoffice: RunConverter = ({ inputs, outDir, profileDir, timeoutMs }) =>
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
      { stdio: ["ignore", "ignore", "pipe"], env: childEnv(profileDir), detached: true }
    );

    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
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
      const { default: mammoth } = await import("mammoth");
      const { value } = await mammoth.extractRawText({ path: absPath });
      return countWords(value);
    } catch {
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

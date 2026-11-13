/**
 * Reads a spreadsheet in a CHILD PROCESS, so a workbook that costs more memory
 * than the web container has can only take the child down.
 *
 * exceljs builds the whole cell model, and that model costs ~20× the sheet XML
 * it came from: a 2.5 MB `.xlsx` holding a 32 MiB sheet peaked at 0.7 GB, a
 * 15 MB one at 3.1 GB — both well inside the archive
 * limits, and both past the 1 GB the web container gets by default
 * (`PINCHY_MEM_LIMIT`). In-process, that is an OOM kill of the web server; on
 * the nightly reindex it is one every night, and because a killed run is
 * requeued at boot, one on every restart too. No size limit can be tuned to
 * stop that without also refusing real workbooks, because the cost is the
 * MODEL, not the bytes.
 *
 * So the reader runs in its own `node`, fenced three ways:
 *
 *  - `--max-old-space-size` caps its heap. A workbook past it ends in V8's
 *    own "heap out of memory" abort — in the child.
 *  - The child raises its own `oom_score_adj` to the maximum before it reads
 *    a byte, so when the CONTAINER runs out first (the heap cap does not
 *    bound Buffers), the kernel picks the child, never the server.
 *  - A timeout, after which the child is killed.
 *
 * Only ONE of those ends is a verdict on this file: V8's own "heap out of
 * memory" banner, which says the heap cap was reached reading it. That is
 * thrown as `OfficeFileRejectedError("too_large")`, and a refusal the child
 * diagnosed itself crosses as the `OfficeFileRejectedError` it was, code and
 * all; ingest books either as a document with no chunks, and the rows route
 * answers 413 for too large and 422 for the rest. Everything else is
 * thrown as a plain error: a SIGKILL without the banner is the container's
 * OOM killer, which `oom_score_adj` aims at the child whatever filled the
 * memory; a timeout can be a host under load; a crash or a child that never
 * got ready is a broken image. Ingest counts a plain error `failed` and keeps
 * whatever the index already held for the file — for a CHANGED file, the
 * version it had indexed — and reads it again next run, instead of branding
 * it unreadable for good. The rows route answers
 * it with 503.
 *
 * One child at a time, process-wide: the index worker and every rows preview
 * share a gate, so the memory one child may use is the memory all of them use.
 * The gate lives on `globalThis` because the worker is loaded by tsx and the
 * route by the Next.js bundle — two module instances, one process. A preview
 * passes its request's `signal`: a queued read whose requester went away
 * leaves the queue, a running one has its child killed. And it passes
 * `maxQueued`, so reloads cannot stack reads in front of the indexer — which
 * passes neither, and is never cut short or turned away.
 *
 * The same child also counts a `.docx` or `.docm`'s words for the conversion's
 * oracle (`countDocxWordsIsolated`), and reads its text for a document whose PDF
 * came out short (`readDocxTextIsolated`). mammoth builds a DOM at
 * up to ~300x the markup it parses, and the markup ceiling in front of it
 * (`MAX_DOCX_MARKUP_BYTES`) is a PREDICTION of which parts mammoth parses: a
 * part it misses is a 13 KB file worth ~900 MB (measured) in whatever
 * process parses it. Behind this fence, a wrong prediction costs the child,
 * never the server. It shares the gate, so
 * the memory one child may use is still the memory all of them use.
 *
 * And it stages every Word and PowerPoint file for conversion
 * (`stageOfficeSourceIsolated`): reads it, checks
 * it, writes the checked copy where the converter will find it, and answers
 * with what it did — never with the bytes. Staging holds a file up to three
 * times over (the original, the verified copy, the sanitized one, each up to
 * 200 MB) and the oracle reads it once more: measured in the web process, one
 * ~190 MB deck cost +570 MB before LibreOffice started, which beside the
 * embedding model OOM-kills a 1 GB container — and a run requeued at boot
 * kills it again. Those copies are Buffers, which the heap cap does
 * not bound; what keeps them off the server is that they are never in it, and
 * `oom_score_adj` is what makes the CHILD the one the kernel kills when they
 * do not fit. A child that stops without the heap banner throws
 * `SheetReaderStoppedError`, which the converter books as infrastructure: the
 * file is read again next run, and the index keeps what it had.
 */
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { OfficeFileRejectedError, StagedCopyWriteError } from "./office-formats";
import type { StagedSource } from "./office-preflight";
import type { ParsedEmail } from "./msg-extract";
import type { TiffConversion } from "./tiff-pdf";
import {
  XlsxExtractionError,
  type SheetRange,
  type XlsxExtraction,
  type XlsxExtractOptions,
} from "./xlsx-extract";

/**
 * The child's heap, in MB. Measured in the shipped image under the default
 * 1 GB container limit — see `XLSX_MAX_PART_BYTES` in office-preflight.ts
 * for the part size this was sized against.
 */
export const SHEET_READER_HEAP_MB = 384;

/** Long enough for the largest workbook the part cap admits on a slow host; a hostile one is killed. */
export const SHEET_READER_TIMEOUT_MS = 120_000;

/**
 * The child's entry module, resolved from the working directory and NOT from
 * this file: Next.js rewrites `__dirname` to a synthetic `/ROOT/…` path in
 * compiled routes (see `lib/skills/index.ts`), and the rows route is one. The
 * server runs from `packages/web` in the image and in dev alike, and the
 * runtime image ships `src/` because tsx executes it.
 */
const CHILD_ENTRY = join(process.cwd(), "src/lib/knowledge/xlsx-isolated-child.ts");

/** What the child is asked to do: one read, then it exits. */
export type SheetReaderRequest =
  | { op: "extract"; path: string; options?: XlsxExtractOptions }
  | { op: "rows"; path: string; sheet: string | null; startRow: number; endRow: number }
  /** Words mammoth sees in the .docx at `path`, read through `readGuardedDocx`. */
  | { op: "docx-words"; path: string }
  /** The text mammoth sees in the .docx at `path` — what `docx-words` counts (#1406). */
  | { op: "docx-text"; path: string }
  /** The Office file at `path`, checked and written to `dest` (`stageOfficeSource`). */
  | { op: "stage-office"; path: string; dest: string }
  /** The TIFF at `path`, one PDF page per frame, written to `dest` (`tiffToPdf`). */
  | { op: "tiff-pdf"; path: string; dest: string; maxFrames: number }
  /** The Outlook message at `path`, parsed to headers and body (`parseMsg`). */
  | { op: "msg"; path: string };

/** What the reader is called in its errors and log lines: the job it was doing. */
function readerName(request: SheetReaderRequest): string {
  switch (request.op) {
    case "docx-words":
      return "word-count reader";
    case "docx-text":
      return "Word text reader";
    case "stage-office":
      return "Office preflight";
    case "tiff-pdf":
      return "TIFF reader";
    case "msg":
      return "Outlook message reader";
    default:
      return "spreadsheet reader";
  }
}

/** A failure the child diagnosed itself, carried across the process boundary by kind. */
export type SheetReaderFailure =
  | { kind: "rejected"; code: OfficeFileRejectedError["code"]; message: string }
  | { kind: "unreadable"; sourcePath: string; reason: string }
  /** The checked copy could not be written: about the volume, not the file. */
  | { kind: "staged-copy-write"; message: string }
  | { kind: "error"; message: string };

/** Every message the child sends. */
export type SheetReaderMessage =
  | { type: "ready" }
  | { type: "result"; value: unknown }
  | { type: "failure"; failure: SheetReaderFailure };

export interface SheetReaderOptions {
  /** Test seam; production uses `SHEET_READER_HEAP_MB`. */
  maxHeapMb?: number;
  /** Test seam; production uses `SHEET_READER_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Test seam: a stub child. Production uses the real reader. */
  entry?: string;
  /**
   * The requester's signal. Once it aborts, a queued read leaves the queue
   * and a running one has its child killed; either way the read rejects with
   * `SheetReaderCancelledError`. The indexer passes none.
   */
  signal?: AbortSignal;
  /**
   * Refuse with `SheetReaderBusyError` instead of queueing behind this many
   * reads already waiting. The indexer passes none, and always queues.
   */
  maxQueued?: number;
}

/**
 * How many reads a rows preview may queue behind before it is answered 503.
 * The indexer reads one file at a time, so it is never more than one of
 * them; the rest are previews, each up to `SHEET_READER_TIMEOUT_MS`.
 */
export const SHEET_PREVIEW_MAX_QUEUED = 2;

/** The read's requester went away first; nothing was read, and nothing is wrong with the file. */
export class SheetReaderCancelledError extends Error {
  constructor() {
    super("the spreadsheet read was cancelled: its requester went away");
    this.name = "SheetReaderCancelledError";
  }
}

/** Too many reads are already waiting for the reader; nothing was read, and nothing is wrong with the file. */
export class SheetReaderBusyError extends Error {
  constructor(waiting: number) {
    super(`the spreadsheet reader is busy: ${waiting} reads are already waiting`);
    this.name = "SheetReaderBusyError";
  }
}

/**
 * The child ended without an answer that is about the file: it could not be
 * started, never got ready, ran out of time, crashed, or was killed from
 * outside without V8's heap banner (the container's OOM killer, which
 * `oom_score_adj` aims at the child whatever filled the memory). Nothing is
 * known about the file; it is read again next run.
 */
export class SheetReaderStoppedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SheetReaderStoppedError";
  }
}

/** stderr kept from the child for the log line: enough for V8's OOM banner, never a flood. */
const MAX_STDERR_CHARS = 4096;

// ---------------------------------------------------------------------------
// The gate: one reader child per process
// ---------------------------------------------------------------------------

interface Gate {
  busy: boolean;
  waiting: Array<() => void>;
}

const GATE_KEY = Symbol.for("pinchy.knowledge.sheetReaderGate");

function gate(): Gate {
  const holder = globalThis as typeof globalThis & { [GATE_KEY]?: Gate };
  return (holder[GATE_KEY] ??= { busy: false, waiting: [] });
}

async function withGate<T>(
  run: () => Promise<T>,
  { signal, maxQueued }: Pick<SheetReaderOptions, "signal" | "maxQueued">
): Promise<T> {
  const g = gate();
  if (signal?.aborted) throw new SheetReaderCancelledError();
  if (g.busy) {
    if (maxQueued !== undefined && g.waiting.length >= maxQueued) {
      throw new SheetReaderBusyError(g.waiting.length);
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", leave);
        resolve();
      };
      // Gone before its turn: out of the queue, so the reads behind it move
      // up and nothing is started for nobody. Once woken, it is `runChild`'s
      // to cancel.
      const leave = () => {
        const at = g.waiting.indexOf(wake);
        if (at < 0) return;
        g.waiting.splice(at, 1);
        reject(new SheetReaderCancelledError());
      };
      g.waiting.push(wake);
      signal?.addEventListener("abort", leave, { once: true });
    });
  }
  // Whoever was woken owns the gate now; `busy` never dropped in between.
  g.busy = true;
  try {
    return await run();
  } finally {
    const next = g.waiting.shift();
    if (next) next();
    else g.busy = false;
  }
}

// ---------------------------------------------------------------------------
// One child, one request
// ---------------------------------------------------------------------------

/** Only what the child needs to run: no database URL, no keys, no tokens. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ["PATH", "TMPDIR", "HOME", "LANG", "TZ"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function failureToError(failure: SheetReaderFailure, name: string): Error {
  switch (failure.kind) {
    case "rejected":
      return new OfficeFileRejectedError(failure.code, failure.message);
    case "unreadable":
      return new XlsxExtractionError(failure.sourcePath, failure.reason);
    case "staged-copy-write":
      return new StagedCopyWriteError(failure.message);
    default:
      return new Error(`${name} failed: ${failure.message}`);
  }
}

/**
 * Why a child that was reading ended without an answer. Only V8's heap-limit
 * banner is a verdict on the file (see the module comment); every other end
 * is a plain error that leaves the file to be read again.
 */
function deathError(
  code: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  stderr: string,
  opts: Required<Pick<SheetReaderOptions, "maxHeapMb" | "timeoutMs">> & { name: string }
): Error {
  if (!timedOut && /heap out of memory|Reached heap limit/i.test(stderr)) {
    return new OfficeFileRejectedError(
      "too_large",
      `reading it needed more than the ${opts.maxHeapMb} MB the ${opts.name} may use`
    );
  }
  if (timedOut) {
    return new SheetReaderStoppedError(
      `the ${opts.name} took longer than ${opts.timeoutMs / 1000} s`
    );
  }
  if (signal === "SIGKILL") {
    return new SheetReaderStoppedError(
      `the ${opts.name} was killed while reading (by the system, most likely out of memory)`
    );
  }
  return new SheetReaderStoppedError(
    `the ${opts.name} stopped while reading (${signal ?? `exit code ${code}`}): ${stderr.trim().slice(0, 500)}`
  );
}

function runChild(request: SheetReaderRequest, options: SheetReaderOptions): Promise<unknown> {
  const maxHeapMb = options.maxHeapMb ?? SHEET_READER_HEAP_MB;
  const timeoutMs = options.timeoutMs ?? SHEET_READER_TIMEOUT_MS;
  const name = readerName(request);

  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(new SheetReaderCancelledError());
      return;
    }
    let child: ChildProcess;
    try {
      child = fork(options.entry ?? CHILD_ENTRY, [], {
        // tsx so the child can load the same TypeScript the server runs;
        // the heap cap is the point of the whole exercise.
        execArgv: ["--import", "tsx", `--max-old-space-size=${maxHeapMb}`],
        env: childEnv(),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        // Structured clone instead of JSON: a big workbook's chunks are tens
        // of MB of strings, and JSON would hold them twice on each side.
        serialization: "advanced",
      });
    } catch (err) {
      reject(new SheetReaderStoppedError(`the ${name} could not be started`, { cause: err }));
      return;
    }

    let ready = false;
    let answered = false;
    let timedOut = false;
    let cancelled = false;
    let stderr = "";

    // Killed, then answered on `exit` like a timeout: the gate opens for the
    // next read only once this child's memory is really gone.
    const cancel = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("message", (message: SheetReaderMessage) => {
      if (message.type === "ready") {
        ready = true;
        return;
      }
      if (answered || (message.type !== "result" && message.type !== "failure")) return;
      answered = true;
      settle();
      if (message.type === "result") resolve(message.value);
      else reject(failureToError(message.failure, name));
    });

    child.on("error", (err) => {
      if (answered) return;
      answered = true;
      settle();
      reject(new SheetReaderStoppedError(`the ${name} could not be started`, { cause: err }));
    });

    child.on("exit", (code, exitSignal) => {
      settle();
      if (answered) return;
      answered = true;
      if (cancelled) {
        reject(new SheetReaderCancelledError());
        return;
      }
      if (!ready && !timedOut) {
        // It never got as far as reading, so nothing here is about the file.
        reject(
          new SheetReaderStoppedError(
            `the ${name} exited before it was ready (${exitSignal ?? `exit code ${code}`}): ${stderr.trim().slice(0, 500)}`
          )
        );
        return;
      }
      reject(deathError(code, exitSignal, timedOut, stderr, { maxHeapMb, timeoutMs, name }));
    });

    child.send(request);
  });
}

/**
 * Throws `SheetReaderBusyError` when a read asking with `maxQueued` would be
 * turned away right now. For a caller with work to do before its read — the
 * rows preview copies the workbook first — so a request the queue will refuse
 * is refused before that work, not after it. The read itself still checks: the
 * queue can fill in between.
 */
export function checkSheetReaderQueue(maxQueued: number): void {
  const g = gate();
  if (g.busy && g.waiting.length >= maxQueued) throw new SheetReaderBusyError(g.waiting.length);
}

/** Runs one request in a fresh, fenced child, one child per process at a time. */
export function runSheetReader(
  request: SheetReaderRequest,
  options: SheetReaderOptions = {}
): Promise<unknown> {
  return withGate(() => runChild(request, options), options);
}

/**
 * `extractXlsx`, in a child process. Same result, same errors, refusals
 * included — plus a refusal (`OfficeFileRejectedError("too_large")`) for a workbook whose read
 * ran out of heap, and a plain error for a reader that died any other way.
 */
export async function extractXlsxIsolated(
  absPath: string,
  opts: XlsxExtractOptions = {},
  readerOptions: SheetReaderOptions = {}
): Promise<XlsxExtraction> {
  return (await runSheetReader(
    { op: "extract", path: absPath, options: opts },
    readerOptions
  )) as XlsxExtraction;
}

/** `readSheetRange`, in a child process — see `extractXlsxIsolated`. */
export async function readSheetRangeIsolated(
  absPath: string,
  sheetName: string | null,
  startRow: number,
  endRow: number,
  readerOptions: SheetReaderOptions = {}
): Promise<SheetRange | null> {
  return (await runSheetReader(
    { op: "rows", path: absPath, sheet: sheetName, startRow, endRow },
    readerOptions
  )) as SheetRange | null;
}

/**
 * The words mammoth sees in the .docx at `absPath`, counted in a child
 * process — the conversion's word-count oracle. The child reads the file
 * itself, through the same guard the conversion input passed
 * (`readGuardedDocx`), so this process never holds it. Same fence, same gate
 * and same errors as the spreadsheet reads: a document the guard refuses, or
 * whose read ran out of heap, is refused (`OfficeFileRejectedError`); any
 * other death is a `SheetReaderStoppedError`.
 */
export async function countDocxWordsIsolated(
  absPath: string,
  readerOptions: SheetReaderOptions = {}
): Promise<number> {
  return (await runSheetReader({ op: "docx-words", path: absPath }, readerOptions)) as number;
}

/**
 * The text mammoth sees in the .docx at `absPath` — the same read
 * `countDocxWordsIsolated` counts — in a child process, through the same
 * guard and behind the same fence. What a Word document is indexed from when
 * its converted PDF came out short (#1406): the oracle has just read the same
 * bytes this way, so it is the one reading of the source known to work. Same
 * errors as the count.
 */
export async function readDocxTextIsolated(
  absPath: string,
  readerOptions: SheetReaderOptions = {}
): Promise<string> {
  return (await runSheetReader({ op: "docx-text", path: absPath }, readerOptions)) as string;
}

/**
 * `stageOfficeSource`, in a child process: the Office file at `absPath` is
 * read, checked and written to `dest` there, and only what was done comes
 * back. Refusals — the preflight's own, or a check that ran out of heap —
 * are `OfficeFileRejectedError`; a child that stopped any other way is a
 * `SheetReaderStoppedError`; a copy the child could not write to `dest` (a
 * full or read-only volume) is a `StagedCopyWriteError`; a file the child
 * could not read (vanished, unreadable) is a plain error.
 */
export async function stageOfficeSourceIsolated(
  absPath: string,
  dest: string,
  readerOptions: SheetReaderOptions = {}
): Promise<StagedSource> {
  return (await runSheetReader(
    { op: "stage-office", path: absPath, dest },
    readerOptions
  )) as StagedSource;
}

/**
 * How long a TIFF conversion may take. Measured on 2026-11-11: 50 A4 frames
 * at 300 dpi took 6.3 s on a developer laptop, so the 200-frame budget is
 * about 25 s there. A small container may be several times slower, and a
 * timeout only turns a working read into a retry — so this is generous.
 */
export const TIFF_READER_TIMEOUT_MS = 600_000;

/**
 * `tiffToPdf`, in a child process. libtiff decodes untrusted bytes and has a
 * long CVE history, so the decode runs behind the same fence as the
 * spreadsheet reads: no secrets in its environment, the first process the
 * OOM killer picks, one at a time. A refusal is `OfficeFileRejectedError`; a
 * child that stopped any other way is a `SheetReaderStoppedError`, and the
 * file is read again next run.
 */
export async function tiffToPdfIsolated(
  absPath: string,
  dest: string,
  opts: { maxFrames: number },
  readerOptions: SheetReaderOptions = {}
): Promise<TiffConversion> {
  return (await runSheetReader(
    { op: "tiff-pdf", path: absPath, dest, maxFrames: opts.maxFrames },
    { timeoutMs: TIFF_READER_TIMEOUT_MS, ...readerOptions }
  )) as TiffConversion;
}

/**
 * `parseMsg`, in a child process (#1409). The parser walks an untrusted
 * Compound File and inflates compressed RTF, so it runs behind the same fence
 * as the other readers. A refusal is `OfficeFileRejectedError`; a child that
 * stopped any other way is a `SheetReaderStoppedError`.
 */
export async function readMsgIsolated(
  absPath: string,
  readerOptions: SheetReaderOptions = {}
): Promise<ParsedEmail> {
  return (await runSheetReader({ op: "msg", path: absPath }, readerOptions)) as ParsedEmail;
}

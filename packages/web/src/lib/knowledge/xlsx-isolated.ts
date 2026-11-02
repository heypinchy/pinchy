/**
 * Reads a spreadsheet in a CHILD PROCESS, so a workbook that costs more memory
 * than the web container has can only take the child down.
 *
 * exceljs builds the whole cell model, and that model costs ~20× the sheet XML
 * it came from: a 2.5 MB `.xlsx` holding a 32 MiB sheet peaked at 0.7 GB, a
 * 15 MB one at 3.1 GB (fourth review, PR #1243) — both well inside the archive
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
 * Any of those ends — and a crash — is a verdict on THIS file: it is refused
 * (`OfficeFileRejectedError("too_large")`), which ingest books as a document
 * with no chunks and the rows route answers with 413. A child that dies before
 * it is ready to read is NOT a verdict on any file (tsx missing, a broken
 * image) and is thrown as a plain error, so ingest counts the file `failed`
 * and keeps whatever the index already held for it, instead of branding every
 * spreadsheet in the corpus unreadable.
 *
 * One child at a time, process-wide: the index worker and every rows preview
 * share a gate, so the memory one child may use is the memory all of them use.
 * The gate lives on `globalThis` because the worker is loaded by tsx and the
 * route by the Next.js bundle — two module instances, one process.
 */
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { OfficeFileRejectedError } from "./office-formats";
import {
  XlsxExtractionError,
  type SheetRange,
  type XlsxExtraction,
  type XlsxExtractOptions,
} from "./xlsx-extract";

/**
 * The child's heap, in MB. Measured in the shipped image under the default
 * 1 GB container limit — see `MAX_WORKBOOK_PART_BYTES` in office-preflight.ts
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
  | { op: "rows"; path: string; sheet: string | null; startRow: number; endRow: number };

/** A failure the child diagnosed itself, carried across the process boundary by kind. */
export type SheetReaderFailure =
  | { kind: "rejected"; code: OfficeFileRejectedError["code"]; message: string }
  | { kind: "unreadable"; sourcePath: string; reason: string }
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

async function withGate<T>(run: () => Promise<T>): Promise<T> {
  const g = gate();
  if (g.busy) await new Promise<void>((resolve) => g.waiting.push(resolve));
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

function failureToError(failure: SheetReaderFailure): Error {
  switch (failure.kind) {
    case "rejected":
      return new OfficeFileRejectedError(failure.code, failure.message);
    case "unreadable":
      return new XlsxExtractionError(failure.sourcePath, failure.reason);
    default:
      return new Error(`spreadsheet reader failed: ${failure.message}`);
  }
}

/** Why a child that was reading ended without an answer — the file's verdict, in words. */
function describeDeath(
  code: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  stderr: string,
  opts: Required<Pick<SheetReaderOptions, "maxHeapMb" | "timeoutMs">>
): string {
  if (timedOut) return `reading it took longer than ${opts.timeoutMs / 1000} s`;
  if (/heap out of memory|Reached heap limit/i.test(stderr)) {
    return `reading it needed more than the ${opts.maxHeapMb} MB the spreadsheet reader may use`;
  }
  if (signal === "SIGKILL") {
    return "the spreadsheet reader was killed while reading it (out of memory)";
  }
  return `the spreadsheet reader stopped while reading it (${signal ?? `exit code ${code}`})`;
}

function runChild(request: SheetReaderRequest, options: SheetReaderOptions): Promise<unknown> {
  const maxHeapMb = options.maxHeapMb ?? SHEET_READER_HEAP_MB;
  const timeoutMs = options.timeoutMs ?? SHEET_READER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
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
      reject(new Error("the spreadsheet reader could not be started", { cause: err }));
      return;
    }

    let ready = false;
    let answered = false;
    let timedOut = false;
    let stderr = "";

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
      clearTimeout(timer);
      if (message.type === "result") resolve(message.value);
      else reject(failureToError(message.failure));
    });

    child.on("error", (err) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      reject(new Error("the spreadsheet reader could not be started", { cause: err }));
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (answered) return;
      answered = true;
      if (!ready && !timedOut) {
        // It never got as far as reading, so nothing here is about the file.
        reject(
          new Error(
            `the spreadsheet reader exited before it was ready (${signal ?? `exit code ${code}`}): ${stderr.trim().slice(0, 500)}`
          )
        );
        return;
      }
      reject(
        new OfficeFileRejectedError(
          "too_large",
          describeDeath(code, signal, timedOut, stderr, { maxHeapMb, timeoutMs })
        )
      );
    });

    child.send(request);
  });
}

/** Runs one request in a fresh, fenced child, one child per process at a time. */
export function runSheetReader(
  request: SheetReaderRequest,
  options: SheetReaderOptions = {}
): Promise<unknown> {
  return withGate(() => runChild(request, options));
}

/**
 * `extractXlsx`, in a child process. Same result, same errors — plus a
 * refusal (`OfficeFileRejectedError("too_large")`) for a workbook whose read
 * ran out of memory or time.
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

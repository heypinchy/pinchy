/**
 * `.docx` → Markdown for `pinchy_read`, with mammoth running in a CHILD
 * PROCESS whose heap is capped.
 *
 * mammoth builds a DOM at up to ~300x the markup it parses, and the OpenClaw
 * container gets 2 GB. The zip guard (`docx-zip-guard.ts`) bounds that markup
 * before mammoth sees it — but it does so by PREDICTING which parts mammoth
 * parses, and three review rounds running found a spelling it predicted
 * wrong: an entity, a character the XML parser normalises, a prefixed
 * attribute, a name JSZip resolves (PR #1243). Each one was a 13 KB file that
 * took this process past 1 GB. The guard now refuses every one of those
 * shapes, and stays as the cheap first layer; what bounds the memory no
 * longer depends on it being right.
 *
 * So the conversion runs in its own `node`, fenced three ways — the same
 * fence the knowledge base puts around its spreadsheet reader
 * (`packages/web/src/lib/knowledge/xlsx-isolated.ts`):
 *
 *  - `--max-old-space-size` caps its heap. A document past it ends in V8's
 *    own "heap out of memory" abort — in the child.
 *  - The child raises its own `oom_score_adj` to the maximum before it reads
 *    a byte, so when the CONTAINER runs out first (the heap cap does not
 *    bound Buffers), the kernel picks the child, never the gateway.
 *  - A timeout, after which the child is killed.
 *
 * Only V8's heap-limit banner is a verdict on the document
 * (`DocxReaderOutOfMemoryError`). A child killed without it, one that crashed,
 * timed out or never got ready is a plain error that says so — the document
 * may read fine on the next try.
 *
 * One child at a time, per process: the memory one child may use is the
 * memory all of them use. Reads queue behind each other.
 *
 * The child runs under Node's own type stripping, because the OpenClaw image
 * has no tsx and its jiti is not on a path a child can load (Node 22.18+
 * strips types by default; the flag below covers 22.6-22.17). That is why the
 * child and `docx-markdown.ts` import only packages and name their `.ts`
 * extensions.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  MAX_DOCX_DECOMPRESSED_BYTES,
  MAX_DOCX_ENTRY_BYTES,
  MAX_DOCX_MARKUP_BYTES,
  verifiedZipCopy,
} from "./docx-zip-guard";
import type { DocxReaderMessage, DocxReaderRequest } from "./docx-reader-protocol";
import { MAX_FILE_SIZE } from "./validate";

export interface DocxExtractionResult {
  text: string;
}

/**
 * Limits for extractDocxText. The defaults are the production values —
 * the overrides exist so tests can exercise each fence without multi-GB
 * fixtures, not as a runtime configuration surface.
 */
export interface DocxExtractOptions {
  /** Cap on the archive's declared decompressed size (issue #424). */
  maxDecompressedBytes?: number;
  /** Cap on any one part's size, pictures included. */
  maxEntryBytes?: number;
  /**
   * Cap on the markup mammoth parses, summed: its DOM costs up to ~300x the
   * XML (see `MAX_DOCX_MARKUP_BYTES`), while a picture costs it nothing.
   */
  maxMarkupBytes?: number;
  /** Cap on the extracted Markdown length — second defense layer. */
  maxTextBytes?: number;
  /** Test seam; production uses `DOCX_READER_HEAP_MB`. */
  maxHeapMb?: number;
  /** Test seam; production uses `DOCX_READER_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Test seam: a stub child. Production uses `docx-reader-child.ts`. */
  childEntry?: string;
  /**
   * Test seam: what converts the verified copy. Production forks the reader
   * child; a test that must prove mammoth was never reached passes a spy.
   */
  read?: (verified: Buffer, maxTextBytes: number) => Promise<string>;
}

// A .docx may not hand the model more text than the largest plain-text file
// pinchy_read would serve.
export const MAX_DOCX_EXTRACTED_TEXT_BYTES = MAX_FILE_SIZE;

/**
 * The reader child's heap, in MB. The markup ceiling admits at most
 * `MAX_DOCX_MARKUP_BYTES` (2 MiB), and the worst shape of that — many tiny
 * paragraphs — needs a heap between 192 MB (dies) and 256 MB (reads it).
 * Measured in the OpenClaw image (Node 22, mammoth 1.13) at this cap
 * (sixth review, PR #1243), peak RSS:
 *
 *   document                                  child     result
 *   2 MiB markup, tiny paragraphs (legit)     443 MB    reads it
 *   2 MiB markup, Word-shaped paragraphs      248 MB    reads it
 *   4 MiB hidden by a prefixed attribute      477 MB    refused: out of memory
 *   30 MiB of markup, guard switched off      503 MB    refused: out of memory
 *
 * while the process that forked it stayed under 120 MB in every case. Without
 * the child the 30 MiB one took the 2 GB OpenClaw container down.
 */
export const DOCX_READER_HEAP_MB = 384;

/** A 2 MiB-markup document converts in a few seconds; a reader still busy after this is killed. */
export const DOCX_READER_TIMEOUT_MS = 60_000;

const CHILD_ENTRY = fileURLToPath(new URL("./docx-reader-child.ts", import.meta.url));

/** stderr kept from the child: enough for V8's OOM banner, never a flood. */
const MAX_STDERR_CHARS = 4096;

/** Reading the document needed more heap than the reader child may have: a verdict on the document. */
export class DocxReaderOutOfMemoryError extends Error {
  constructor(heapMb: number) {
    super(
      `This document needs more memory to read than pinchy_read may use (${heapMb} MB), so it was not read.`
    );
    this.name = "DocxReaderOutOfMemoryError";
  }
}

/**
 * Extract a DOCX buffer as Markdown (see `docx-markdown.ts` for the pipeline).
 *
 * Issue #424: decompression bombs are rejected from the central directory's
 * declared sizes before anything is inflated — and, since an archive can lie
 * about those sizes, every entry's REAL size is verified too, and the reader
 * is handed a copy built only from entries that held up (release review
 * v0.10.0). mammoth never sees the bytes it was given. That copy is then
 * converted in the heap-capped reader child.
 */
export async function extractDocxText(
  buffer: Buffer,
  options: DocxExtractOptions = {}
): Promise<DocxExtractionResult> {
  const verified = await verifiedZipCopy(buffer, {
    maxDecompressedBytes: options.maxDecompressedBytes ?? MAX_DOCX_DECOMPRESSED_BYTES,
    maxEntryBytes: options.maxEntryBytes ?? MAX_DOCX_ENTRY_BYTES,
    // The first layer: past this the guard answers with its own error
    // ("…bytes of markup to parse, past the …-byte limit…") without starting
    // a reader at all (fourth review, PR #1243).
    maxMarkupBytes: options.maxMarkupBytes ?? MAX_DOCX_MARKUP_BYTES,
  });
  const maxTextBytes = options.maxTextBytes ?? MAX_DOCX_EXTRACTED_TEXT_BYTES;
  const read = options.read ?? ((data, max) => readIsolated(data, max, options));
  return { text: await read(verified, maxTextBytes) };
}

// ---------------------------------------------------------------------------
// The gate: one reader child per process
// ---------------------------------------------------------------------------

interface Gate {
  busy: boolean;
  waiting: Array<() => void>;
}

// On globalThis, so a second instance of this module (a plugin reload) shares it.
const GATE_KEY = Symbol.for("pinchy.files.docxReaderGate");

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
// One child, one document
// ---------------------------------------------------------------------------

/** Only what the child needs to run: no gateway token, no provider keys. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ["PATH", "TMPDIR", "HOME", "LANG", "TZ"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function readIsolated(
  data: Buffer,
  maxTextBytes: number,
  options: DocxExtractOptions
): Promise<string> {
  return withGate(() => runChild({ data, maxTextBytes }, options));
}

function runChild(request: DocxReaderRequest, options: DocxExtractOptions): Promise<string> {
  const heapMb = options.maxHeapMb ?? DOCX_READER_HEAP_MB;
  const timeoutMs = options.timeoutMs ?? DOCX_READER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = fork(options.childEntry ?? CHILD_ENTRY, [], {
        execArgv: [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          `--max-old-space-size=${heapMb}`,
        ],
        env: childEnv(),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        // Structured clone: the document goes over as bytes, not as JSON.
        serialization: "advanced",
      });
    } catch (err) {
      reject(new Error("The .docx reader could not be started.", { cause: err }));
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

    child.on("message", (message: DocxReaderMessage) => {
      if (message.type === "ready") {
        ready = true;
        return;
      }
      if (answered || (message.type !== "result" && message.type !== "failure")) return;
      answered = true;
      clearTimeout(timer);
      if (message.type === "result") resolve(message.text);
      else reject(new Error(message.message));
    });

    child.on("error", (err) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      reject(new Error("The .docx reader could not be started.", { cause: err }));
    });

    // The gate opens for the next read only once this child is really gone.
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (answered) return;
      answered = true;
      const detail = `${signal ?? `exit code ${code}`}: ${stderr.trim().slice(0, 500)}`;
      if (!ready && !timedOut) {
        reject(new Error(`The .docx reader exited before it was ready (${detail})`));
      } else if (!timedOut && /heap out of memory|Reached heap limit/i.test(stderr)) {
        reject(new DocxReaderOutOfMemoryError(heapMb));
      } else if (timedOut) {
        reject(
          new Error(`Reading this .docx took longer than ${timeoutMs / 1000} s, so it was stopped.`)
        );
      } else if (signal === "SIGKILL") {
        reject(
          new Error(
            "The .docx reader was killed while reading (by the system, most likely out of memory). Try again."
          )
        );
      } else {
        reject(new Error(`The .docx reader stopped while reading (${detail})`));
      }
    });

    child.send(request);
  });
}

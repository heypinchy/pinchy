/**
 * The web ↔ office-converter protocol: both halves, one module.
 *
 * ## Why a sidecar
 *
 * LibreOffice parses files that anyone with write access to a mounted share
 * can plant. Inside the `pinchy` container it had a network (the Docker
 * network, and through it the host and the internet) and could read
 * `/openclaw-config`, the secrets and the agent workspaces. The profile and the
 * preflight (PR #1243) configure that process not to fetch or embed; they do
 * not take the ability away. The `office-converter` service does: it runs with
 * `network_mode: none` — `lo` is its only interface — and mounts nothing but
 * the spool. A document that talks LibreOffice past every setting still finds
 * no network to reach and no secret to read. See
 * plans/2026-11-02-kb-office-converter-sidecar-design.md.
 *
 * ## The protocol
 *
 * HTTP over a Unix socket in the shared spool volume — the one channel
 * `network_mode: none` leaves open, reachable only by a container that mounts
 * the spool. The web side stages a batch under `<spool>/<uuid>/{in,out,profile}`
 * (the spool is mounted at the same path in both containers) and sends
 * `POST /convert {batch, inputs, timeoutMs}`. The sidecar never takes a path
 * from the request: it checks the batch id and the index names and derives
 * every path itself. It answers with the converter's `ConverterResult`.
 *
 * Every way of NOT getting an answer — no socket, a refused request, a sidecar
 * that dies or hangs — rejects, which office-convert books as `infrastructure`:
 * retryable, never "this document is unreadable".
 *
 * Node built-ins only: the sidecar imports this, and it must not drag the web
 * app's dependency graph into a container whose point is to hold nothing.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { basename, dirname, join } from "node:path";

import { OFFICE_EXTENSIONS } from "./office-formats";
import type { ConverterResult, ConverterRun, RunConverter } from "./office-soffice";

/** The socket's name inside the spool. */
export const CONVERTER_SOCKET_NAME = "converter.sock";

export function converterSocketPath(spoolDir: string): string {
  return join(spoolDir, CONVERTER_SOCKET_NAME);
}

/**
 * The sidecar's ceiling on one batch. office-convert asks for
 * `60 s + 10 s × files` — under four minutes for a default batch of 20 — so
 * this only bites a request that is wrong, and keeps a wrong one from pinning
 * a converter for a day.
 */
export const DEFAULT_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How much longer than the batch's own budget the web side waits for an
 * answer. The sidecar enforces the budget and replies; this is only for a
 * sidecar that cannot reply at all.
 */
const DEFAULT_GRACE_MS = 30_000;

/**
 * A staged batch older than this is a leftover — its web process died before
 * its `finally` could remove it. No batch lives longer than its budget.
 */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUT_NAME = new RegExp(
  `^\\d{1,4}(?:${OFFICE_EXTENSIONS.map((e) => e.replace(".", "\\.")).join("|")})$`
);
const MAX_INPUTS = 1000;
const MAX_REQUEST_BYTES = 64 * 1024;

interface ConvertRequest {
  batch: string;
  inputs: string[];
  timeoutMs: number;
}

/** The paths of one batch, derived from its id — never taken from a request. */
function batchPaths(spoolDir: string, batch: string) {
  const dir = join(spoolDir, batch);
  return {
    dir,
    inDir: join(dir, "in"),
    outDir: join(dir, "out"),
    profileDir: join(dir, "profile"),
  };
}

// ---------------------------------------------------------------------------
// Web side
// ---------------------------------------------------------------------------

export interface SidecarConverter {
  runConverter: RunConverter;
  /** A fresh batch directory in the spool, where the sidecar can see it. */
  createStagingDir: () => Promise<string>;
}

export interface SidecarConverterOptions {
  graceMs?: number;
  staleAfterMs?: number;
}

export function sidecarConverter(
  spoolDir: string,
  options: SidecarConverterOptions = {}
): SidecarConverter {
  const socketPath = converterSocketPath(spoolDir);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return {
    async createStagingDir() {
      await pruneStaleBatches(spoolDir, staleAfterMs);
      const dir = join(spoolDir, randomUUID());
      await mkdir(dir, { recursive: true });
      return dir;
    },

    async runConverter(run) {
      const body = JSON.stringify(toRequest(spoolDir, run));
      return new Promise<ConverterResult>((resolve, reject) => {
        const req = request(
          {
            socketPath,
            method: "POST",
            path: "/convert",
            headers: { "content-type": "application/json" },
          },
          (res) => {
            readBody(res)
              .then((text) => {
                if (res.statusCode !== 200) {
                  reject(new Error(`office converter refused the batch: ${errorOf(text)}`));
                  return;
                }
                resolve(parseResult(text));
              })
              .catch(reject);
          }
        );
        req.setTimeout(run.timeoutMs + graceMs, () => {
          req.destroy(
            new Error(
              `office converter did not answer within ${Math.round((run.timeoutMs + graceMs) / 1000)} s`
            )
          );
        });
        req.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
            reject(
              new Error(
                `office converter is not reachable at ${socketPath} (${err.code}) — is the office-converter service running? See the upgrade notes: it needs the current docker-compose.yml`
              )
            );
            return;
          }
          reject(err);
        });
        req.end(body);
      });
    },
  };
}

/**
 * The request for a run that office-convert staged through
 * `createStagingDir` — or an error, before anything is sent, for a run that
 * was staged anywhere else. The sidecar could not see such a batch, and a
 * request naming one would be a bug, not a conversion.
 */
function toRequest(spoolDir: string, run: ConverterRun): ConvertRequest {
  const dir = dirname(run.outDir);
  const batch = basename(dir);
  const expected = batchPaths(spoolDir, batch);
  const inside =
    dirname(dir) === spoolDir &&
    BATCH_ID.test(batch) &&
    run.outDir === expected.outDir &&
    run.profileDir === expected.profileDir &&
    run.inputs.every((input) => dirname(input) === expected.inDir);
  if (!inside) {
    throw new Error(
      `refusing to convert a batch staged outside the office converter's spool (${spoolDir})`
    );
  }
  return { batch, inputs: run.inputs.map((input) => basename(input)), timeoutMs: run.timeoutMs };
}

function parseResult(text: string): ConverterResult {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error("office converter sent an answer that is not a result");
  }
  const { code, signal, stderr, timedOut } = value as Record<string, unknown>;
  if (
    (code !== null && typeof code !== "number") ||
    (signal !== null && typeof signal !== "string") ||
    typeof stderr !== "string" ||
    typeof timedOut !== "boolean"
  ) {
    throw new Error("office converter sent an answer that is not a result");
  }
  return { code, signal: signal as NodeJS.Signals | null, stderr, timedOut };
}

/** Removes batch directories a crashed web process left behind. Best effort. */
async function pruneStaleBatches(spoolDir: string, staleAfterMs: number): Promise<void> {
  const cutoff = Date.now() - staleAfterMs;
  let entries: string[];
  try {
    entries = await readdir(spoolDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!BATCH_ID.test(entry)) continue;
    const path = join(spoolDir, entry);
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory() && info.mtimeMs < cutoff) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Sidecar side
// ---------------------------------------------------------------------------

export interface OfficeConverterServerOptions {
  spoolDir: string;
  runConverter: RunConverter;
  maxTimeoutMs?: number;
}

export function createOfficeConverterServer(options: OfficeConverterServerOptions): Server {
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;

  return createServer((req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };

    if (req.method === "GET" && req.url === "/health") {
      reply(200, { ok: true });
      return;
    }
    if (req.method !== "POST" || req.url !== "/convert") {
      reply(404, { error: "not found" });
      return;
    }

    readBody(req, MAX_REQUEST_BYTES)
      .then(async (text) => {
        const parsed = parseRequest(text);
        if (typeof parsed === "string") {
          reply(400, { error: parsed });
          return;
        }
        const paths = batchPaths(options.spoolDir, parsed.batch);
        try {
          const result = await options.runConverter({
            inputs: parsed.inputs.map((name) => join(paths.inDir, name)),
            outDir: paths.outDir,
            profileDir: paths.profileDir,
            timeoutMs: Math.min(parsed.timeoutMs, maxTimeoutMs),
          });
          reply(200, result);
        } catch (err) {
          reply(500, { error: err instanceof Error ? err.message : String(err) });
        }
      })
      .catch((err: unknown) => {
        reply(400, { error: err instanceof Error ? err.message : String(err) });
      });
  });
}

/** A valid request, or the reason it is not one. */
function parseRequest(text: string): ConvertRequest | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "body is not JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "body is not an object";
  }
  const { batch, inputs, timeoutMs } = value as Record<string, unknown>;
  if (typeof batch !== "string" || !BATCH_ID.test(batch)) return "batch is not a staging id";
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_INPUTS) {
    return `inputs must list 1–${MAX_INPUTS} files`;
  }
  if (!inputs.every((name) => typeof name === "string" && INPUT_NAME.test(name))) {
    return "inputs must be index-named Office files (<n>.doc|docx|ppt|pptx)";
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return "timeoutMs must be a positive number";
  }
  return { batch, inputs: inputs as string[], timeoutMs };
}

/**
 * Starts listening on the spool's socket, replacing a socket file a previous
 * sidecar left behind (a crash does not unlink it, and `listen` refuses an
 * existing path).
 */
export async function listenOfficeConverter(server: Server, spoolDir: string): Promise<void> {
  const socketPath = converterSocketPath(spoolDir);
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function readBody(stream: IncomingMessage, limit = Number.POSITIVE_INFINITY): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > limit) {
        stream.destroy();
        reject(new Error("request body too large"));
      }
    });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}

function errorOf(text: string): string {
  try {
    const value = JSON.parse(text) as { error?: unknown };
    if (typeof value.error === "string") return value.error;
  } catch {
    // fall through
  }
  return text.slice(0, 200);
}

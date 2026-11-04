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
 * ## Who may write what
 *
 * The sidecar runs as its own uid in the web process's group
 * (docker-compose.yml). The web process owns the spool and every batch
 * directory in it; the modes in `BATCH_MODES` let the converter read `in/`
 * and write `out/` and `profile/`, and nothing else. The spool root and the
 * two writable directories are sticky, so the converter can remove or rename
 * only entries it created itself — its socket, its own output. It cannot
 * swap a staged input, nor touch another batch.
 *
 * The converter can still create entries of its own in those directories,
 * and rearrange them at any time. So the web process never walks into a
 * directory the converter made: it removes a batch entry by entry
 * (`removeBatch`), opens an output without following it and without waiting
 * on it (office-convert.ts), and reads at most `MAX_RESPONSE_BYTES` of an
 * answer.
 *
 * Node built-ins only: the sidecar imports this, and it must not drag the web
 * app's dependency graph into a container whose point is to hold nothing.
 */
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";

import { OFFICE_EXTENSIONS } from "./office-formats";
import type { ConverterResult, ConverterRun, RunConverter } from "./office-soffice";

/** The socket's name inside the spool. */
export const CONVERTER_SOCKET_NAME = "converter.sock";

export function converterSocketPath(spoolDir: string): string {
  return join(spoolDir, CONVERTER_SOCKET_NAME);
}

/**
 * The sidecar's ceiling on one batch. office-convert asks for
 * `60 s + 10 s × files` — 4 min 20 s for a default batch of 20 — so
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
 * How long a refused connection is retried: a converter that recycled itself
 * is back within seconds (the restart policy starts it at once, and it only
 * has to load). Long enough for that on a busy host; a run pays it once, not
 * per batch (`gaveUp`).
 */
const DEFAULT_CONNECT_RETRY_MS = 20_000;

/**
 * Sockets whose retry window ran out with nobody answering. Until one answers
 * again, later batches get one attempt each instead of a window of their own:
 * a run converts batch after batch, each with its own converter client, and
 * without this a stopped converter would cost every batch the full wait and
 * hold the index worker for hours. A converter that is back is used at once.
 */
const gaveUp = new Set<string>();

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
/**
 * An answer is a few fields and at most 8 KB of stderr (office-soffice.ts),
 * which JSON escapes to at most six times that. Anything bigger is not one.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Modes of a staged batch (see "Who may write what" above). Set with `chmod`,
 * not through `mkdir`'s mode, which the process umask would cut.
 */
export const BATCH_MODES = {
  batch: 0o750,
  in: 0o750,
  out: 0o1770,
  profile: 0o1770,
} as const;

/** The socket: the web process's group connects, nobody else. */
const SOCKET_MODE = 0o660;

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
  /** Removes a batch without walking into anything the converter made. */
  removeStagingDir: (dir: string) => Promise<void>;
}

export interface SidecarConverterOptions {
  graceMs?: number;
  /**
   * How long to keep trying a socket that is there but refuses connections —
   * a converter between its exit and its restart. It never unlinks its socket
   * on the way out — not when it recycles itself after a batch that left
   * processes behind, not when Docker stops it — so a missing socket means no
   * converter service at all, and that is not retried.
   */
  connectRetryMs?: number;
  connectIntervalMs?: number;
  staleAfterMs?: number;
  /** The web process's uid: only batches it owns are pruned. */
  uid?: number;
}

export function sidecarConverter(
  configuredSpoolDir: string,
  options: SidecarConverterOptions = {}
): SidecarConverter {
  // Normalised once: the staging check compares paths as strings, and a
  // trailing or doubled slash in KB_OFFICE_SPOOL_DIR must not refuse every
  // batch.
  const spoolDir = resolve(configuredSpoolDir);
  const socketPath = converterSocketPath(spoolDir);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const connectRetryMs = options.connectRetryMs ?? DEFAULT_CONNECT_RETRY_MS;
  const connectIntervalMs = options.connectIntervalMs ?? 500;

  /** One request; nothing has reached the converter when it fails with ECONNREFUSED. */
  const send = async (body: string, timeoutMs: number) => {
    // The converter owns this entry and could put a link there; connect()
    // would follow it. Only a socket is connected to. (A swap between this
    // check and the connect is not excluded — design record, "The spool".)
    const entry = await lstat(socketPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (entry && !entry.isSocket()) {
      throw new Error(`office converter socket at ${socketPath} is not a socket`);
    }
    return new Promise<ConverterResult>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          // One request per batch, minutes apart: a pooled keep-alive socket
          // buys nothing and can be closed by the sidecar just as it is reused.
          agent: false,
          method: "POST",
          path: "/convert",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          readBody(res, MAX_RESPONSE_BYTES)
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
      req.setTimeout(timeoutMs + graceMs, () => {
        req.destroy(
          new Error(
            `office converter did not answer within ${Math.round((timeoutMs + graceMs) / 1000)} s`
          )
        );
      });
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNRESET") {
          // A batch in flight when the converter was stopped or restarted.
          reject(
            new Error(
              `office converter closed the connection before answering (${err.code}) — it was stopped or restarted during the batch`
            )
          );
          return;
        }
        if (err.code === "ENOENT") {
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
  };

  return {
    removeStagingDir: removeBatch,

    async createStagingDir() {
      await pruneStaleBatches(spoolDir, staleAfterMs, uid);
      const paths = batchPaths(spoolDir, randomUUID());
      for (const [key, path] of [
        ["batch", paths.dir],
        ["in", paths.inDir],
        ["out", paths.outDir],
        ["profile", paths.profileDir],
      ] as const) {
        await mkdir(path);
        await chmod(path, BATCH_MODES[key]);
      }
      return paths.dir;
    },

    async runConverter(run) {
      const body = JSON.stringify(toRequest(spoolDir, run));
      // Waited out recently and nobody came: one attempt, no new window.
      const waitedBefore = gaveUp.has(socketPath);
      const deadline = waitedBefore ? 0 : Date.now() + connectRetryMs;
      for (;;) {
        try {
          const result = await send(body, run.timeoutMs);
          gaveUp.delete(socketPath);
          return result;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw err;
          if (Date.now() >= deadline) {
            gaveUp.add(socketPath);
            throw new Error(
              `office converter is not answering at ${socketPath} (ECONNREFUSED) — it is not running or keeps restarting; see \`docker compose logs office-converter\``
            );
          }
          await new Promise((resolve) => setTimeout(resolve, connectIntervalMs));
        }
      }
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

/**
 * Removes one batch, entry by entry: the staged inputs, whatever sits
 * directly in `out/` and `profile/` (a link or a file is unlinked, never
 * followed), then the directories the web process made. It does not descend
 * into a directory the converter created; one left there keeps the batch, and
 * the final `rmdir` throws so the caller can say so. The converter clears
 * `profile/` itself, after every batch and when it starts.
 *
 * Every path here is safe to use by name: the spool root is sticky and the
 * batch directory is not writable by the converter, so it cannot swap any
 * component on the way.
 */
async function removeBatch(dir: string): Promise<void> {
  for (const sub of ["in", "out", "profile"]) {
    const path = join(dir, sub);
    for (const entry of await readdir(path).catch(() => [] as string[])) {
      await unlink(join(path, entry)).catch(() => {});
    }
    await rmdir(path).catch(() => {});
  }
  await rmdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

/**
 * Removes batch directories a crashed web process left behind. Best effort.
 * Only real directories this process owns: the converter can create entries
 * in the spool root too, links among them, and those are not ours to walk.
 */
async function pruneStaleBatches(
  spoolDir: string,
  staleAfterMs: number,
  uid: number
): Promise<void> {
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
    const info = await lstat(path).catch(() => null);
    if (info?.isDirectory() && info.uid === uid && info.mtimeMs < cutoff) {
      await removeBatch(path).catch(() => {});
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
  /**
   * Processes left running in the container, asked after every batch. The
   * default finds none; the entrypoint reads /proc (`leftoverProcesses`).
   */
  leftovers?: () => Promise<number[]>;
  /**
   * Called once the answer to such a batch is sent. The entrypoint exits, so
   * the restart policy starts a clean container.
   */
  onLeftovers?: (pids: number[]) => void;
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
        let answer: [number, unknown];
        try {
          const result = await options.runConverter({
            inputs: parsed.inputs.map((name) => join(paths.inDir, name)),
            outDir: paths.outDir,
            profileDir: paths.profileDir,
            timeoutMs: Math.min(parsed.timeoutMs, maxTimeoutMs),
          });
          answer = [200, result];
        } catch (err) {
          answer = [500, { error: err instanceof Error ? err.message : String(err) }];
        }
        // The profile is the converter's, made of directories with modes
        // LibreOffice picks. Emptied here, by the uid that created it, so the
        // web process can always remove the batch.
        await clearDirectory(paths.profileDir);
        const left = (await options.leftovers?.()) ?? [];
        if (left.length > 0) {
          // Whether or not the web process is still there to hear it.
          const recycle = () => options.onLeftovers?.(left);
          if (res.destroyed) recycle();
          else res.once("close", recycle);
          reply(500, {
            error: `the converter left ${left.length} process(es) running after the batch; the office-converter restarts`,
          });
          return;
        }
        reply(...answer);
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
 * Starts listening on the spool's socket, replacing the socket a previous
 * converter left behind (it never unlinks it on the way out, and `listen`
 * refuses an existing path).
 *
 * It binds under a temporary name and renames that over the old socket, so
 * the path is never missing: a web process retrying through a restart finds a
 * socket that refuses, then one that answers — never none, which would read
 * as "no converter service" and not be retried.
 */
export async function listenOfficeConverter(server: Server, spoolDir: string): Promise<void> {
  const socketPath = converterSocketPath(spoolDir);
  // Temporary names of starts that died before their rename; ours to remove.
  for (const entry of await readdir(spoolDir).catch(() => [] as string[])) {
    if (/^converter\.sock\.\d+\.new$/.test(entry)) {
      await rm(join(spoolDir, entry), { force: true }).catch(() => {});
    }
  }
  const fresh = `${socketPath}.${process.pid}.new`;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(fresh, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The web process connects as another uid, through the group.
  await chmod(fresh, SOCKET_MODE);
  await rename(fresh, socketPath);
}

/**
 * The converter's side of cleaning up, run when it starts: empties the
 * profile of every batch in the spool. A converter that died mid-batch leaves
 * its profile behind, and only this uid may remove what is in it. `out/` is
 * left alone — a PDF there may be one the web process is about to take.
 */
export async function sweepSpool(spoolDir: string): Promise<void> {
  for (const entry of await readdir(spoolDir).catch(() => [] as string[])) {
    if (!BATCH_ID.test(entry)) continue;
    const info = await lstat(join(spoolDir, entry)).catch(() => null);
    if (info?.isDirectory()) await clearDirectory(batchPaths(spoolDir, entry).profileDir);
  }
}

/** Removes everything inside `dir`, leaving `dir` itself. Best effort. */
async function clearDirectory(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    await rm(join(dir, entry), { recursive: true, force: true }).catch(() => {});
  }
}

export interface LeftoverProcessOptions {
  procDir?: string;
  /** The server's own pid. */
  self?: number;
  /** How long a process on its way out gets to finish dying. */
  graceMs?: number;
  intervalMs?: number;
}

/**
 * The processes left running in the converter's container, by pid — empty
 * when there are none. Asked after every batch.
 *
 * The container runs under an init (`init: true` in docker-compose.yml, kept
 * there by the drift guard): PID 1, with this server as its child. A process
 * whose parent is the init and that is not this server is an orphan — the
 * kind a batch leaves when a group kill misses something, or something moves
 * out of its group. Children of this server are not counted: `soffice` has
 * exited by the time a batch answers, and what stays is tsx's `esbuild`,
 * which lives as long as the server (both seen in the image). Processes
 * `docker exec` starts — the healthcheck — have no parent inside the
 * container, and a zombie is about to be reaped; neither counts.
 *
 * Without /proc (a developer machine) there is nothing to read, and it finds
 * nothing.
 */
export async function leftoverProcesses(options: LeftoverProcessOptions = {}): Promise<number[]> {
  const deadline = Date.now() + (options.graceMs ?? 2_000);
  for (;;) {
    const left = await orphans(options);
    if (left.length === 0 || Date.now() >= deadline) return left;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }
}

async function orphans(options: LeftoverProcessOptions): Promise<number[]> {
  const procDir = options.procDir ?? "/proc";
  const self = options.self ?? process.pid;
  const entries = await readdir(procDir).catch(() => [] as string[]);
  const left: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === 1 || pid === self) continue;
    const stat = await readFile(join(procDir, entry, "stat"), "utf8").catch(() => null);
    if (stat === null) continue; // gone since the listing
    // `pid (comm) state ppid …` — comm may hold spaces and parentheses, so
    // read the fields after the LAST ')'.
    const [state, ppid] = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    if (state === "Z" || state === "X") continue;
    if (Number(ppid) === 1) left.push(pid);
  }
  return left.sort((a, b) => a - b);
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

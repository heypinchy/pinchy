// Read OpenClaw session index + trajectory JSONL from the shared
// `openclaw-config` volume. The Pinchy container mounts this volume at
// `/openclaw-config` by default; integration tests point it at a tmpdir via
// `OPENCLAW_STATE_DIR`. Do NOT trust absolute paths recorded inside
// `sessions.json` (those reference OpenClaw's `/root/.openclaw/...` view of
// the volume, which differs from Pinchy's mount point) — always rebuild paths
// from the configured state directory.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_STATE_DIR = "/openclaw-config";

// OpenClaw (root) rewrites `sessions.json` / `*.trajectory.jsonl` as mode 0600
// on every session update; start-openclaw.sh's chmod loop reopens them to
// 0644/0755 within ~50ms, but Pinchy (uid 999) can read in that window and hit
// a TRANSIENT EACCES. Letting that abort the read silently drops the turn's
// per-turn usage (the chat-`done` recorder and the poller both read these
// files): in production the turn is under-counted until a later poll happens to
// land outside a 0600 window; in CI the delayed row leaks into a later
// usage-tracking spec's before→after measurement window and flakes the
// exact-token assertion. A transient EACCES therefore means "retry after a
// chmod-loop tick", NOT "give up".
//
// ENOENT is deliberately NOT retried — it's the legitimate "no session /
// trajectory recorded yet" case the callers translate to null /
// TrajectoryFileNotFoundError and the usage poller backstops on its next pass.
//
// Bounded budget mirrors openclaw-config/write.ts's #314 retry: 5 × 100ms
// covers two chmod-loop ticks worst case. Async sleep (not the sync busy-wait
// used there) because these readers are already async and run off-request.
const EACCES_RETRY_ATTEMPTS = 5;
const EACCES_RETRY_DELAY_MS = 100;

async function readFileResilient(path: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" || attempt >= EACCES_RETRY_ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, EACCES_RETRY_DELAY_MS));
    }
  }
}

function getStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR ?? DEFAULT_STATE_DIR;
}

// Defense-in-depth against path traversal: even though `agentId` is
// DB-validated by the route, `sessionId` comes from a JSON file on a shared
// volume. Reject any segment that could escape the per-agent sessions
// directory rather than trying to normalize it.
function assertSafeSegment(segment: string, kind: string): void {
  if (
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("..") ||
    segment.includes("\0")
  ) {
    throw new Error(`Invalid ${kind}: refusing to join unsafe path segment`);
  }
}

function sessionsDir(agentId: string): string {
  return join(getStateDir(), "agents", agentId, "sessions");
}

/**
 * Thrown when a trajectory file is missing. Wraps the underlying ENOENT so
 * route handlers can distinguish "no session recorded yet" from real IO
 * errors when they choose to.
 */
export class TrajectoryFileNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Trajectory file not found: ${path}`);
    this.name = "TrajectoryFileNotFoundError";
    this.path = path;
  }
}

interface SessionIndexEntry {
  sessionId?: unknown;
}

/**
 * Resolve a sessionKey to the sessionId stored in the per-agent sessions.json
 * index. Returns null when the index file or the matching entry are missing,
 * or when the entry has no sessionId field.
 */
export async function resolveSessionId(
  agentId: string,
  sessionKey: string
): Promise<string | null> {
  assertSafeSegment(agentId, "agentId");
  const path = join(sessionsDir(agentId), "sessions.json");
  let raw: string;
  try {
    raw = await readFileResilient(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const index = parsed as Record<string, SessionIndexEntry>;
  // Lookup is exact-first then case-insensitive: OpenClaw normalizes the
  // `<userId>` segment of the sessionKey when writing the index (observed
  // `1BCj... -> 1bcj...` in CI). Matching strictly on Pinchy's
  // `session.user.id` therefore misses every entry. The case-insensitive
  // fallback recovers OpenClaw's normalization without hardcoding the rule.
  let entry = index[sessionKey];
  if (!entry || typeof entry !== "object") {
    const wanted = sessionKey.toLowerCase();
    const fallbackKey = Object.keys(index).find((k) => k.toLowerCase() === wanted);
    if (!fallbackKey) return null;
    entry = index[fallbackKey];
    if (!entry || typeof entry !== "object") return null;
  }
  const sessionId = entry.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

/**
 * Read the trajectory JSONL file for the given agent+session. Throws
 * `TrajectoryFileNotFoundError` if the file is missing (ENOENT); other IO
 * errors propagate untouched.
 */
export async function readTrajectoryJsonl(agentId: string, sessionId: string): Promise<string> {
  assertSafeSegment(agentId, "agentId");
  assertSafeSegment(sessionId, "sessionId");
  const path = join(sessionsDir(agentId), `${sessionId}.trajectory.jsonl`);
  try {
    return await readFileResilient(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TrajectoryFileNotFoundError(path);
    }
    throw err;
  }
}

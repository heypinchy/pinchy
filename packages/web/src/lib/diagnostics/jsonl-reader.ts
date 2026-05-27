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
 * Diagnostic helper: returns a sanitized snapshot of the on-disk session
 * index for an agent. Used by the diagnostics-export route's 404 path so
 * operators can see whether the index is missing, empty, or carries keys
 * with a different shape than the requested sessionKey. Never returns raw
 * user-id suffixes — only the agentId portion and a count.
 */
export async function inspectSessionIndex(agentId: string): Promise<{
  fileExists: boolean;
  keyCount: number;
  keyShapes: string[];
}> {
  assertSafeSegment(agentId, "agentId");
  const path = join(sessionsDir(agentId), "sessions.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { fileExists: false, keyCount: 0, keyShapes: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fileExists: true, keyCount: 0, keyShapes: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { fileExists: true, keyCount: 0, keyShapes: [] };
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  // Strip user-id suffix from each key — keep the structural prefix so we
  // can tell at a glance whether the right agentId / scope is present.
  const keyShapes = keys.map((k) => {
    const parts = k.split(":");
    if (parts.length < 4) return k.replace(/[a-zA-Z0-9]{6,}/g, "<id>");
    // agent:<agentId>:direct:<userId> -> agent:<agentId>:direct:<userId-prefix>
    return `${parts.slice(0, 3).join(":")}:${parts[3].slice(0, 4)}...`;
  });
  return { fileExists: true, keyCount: keys.length, keyShapes };
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
    raw = await readFile(path, "utf8");
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
  const entry = (parsed as Record<string, SessionIndexEntry>)[sessionKey];
  if (!entry || typeof entry !== "object") return null;
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
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TrajectoryFileNotFoundError(path);
    }
    throw err;
  }
}

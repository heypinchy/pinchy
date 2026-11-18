// Read a session's trajectory on Pinchy's behalf.
//
// Up to OpenClaw 2026.8 the session index (`sessions/sessions.json`) and each
// session's trajectory (`sessions/<sessionId>.trajectory.jsonl`) were files on
// the shared state volume, and Pinchy read them directly for per-turn usage and
// the diagnostics export. OpenClaw 2026.9 moved both into a per-agent SQLite
// database, `agents/<agentId>/agent/openclaw-agent.sqlite`, which OpenClaw keeps
// at mode 0600 and re-asserts after its own writes. Pinchy (uid 999, another
// container) cannot read it, and a second process reading a WAL database it
// cannot write would not be safe anyway. So the read happens here, inside the
// gateway process that owns the file, and Pinchy asks for it over the gateway
// connection it already holds.
//
// The events are the same `openclaw-trajectory` records the JSONL files held
// (`event_json` is one former line), so the answer is JSONL again and Pinchy's
// parsers stay as they were.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TRAJECTORY_READ_METHOD = "pinchy.trajectory.read";

export interface TrajectoryReadParams {
  stateDir: string;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
}

export interface TrajectoryReadResult {
  /** The session the events belong to; null when the key resolves to none. */
  sessionId: string | null;
  /** The events as JSONL, oldest first; null when none are recorded. */
  jsonl: string | null;
}

class InvalidRequestError extends Error {}

// The agentId becomes a path segment. It comes from Pinchy's database, but a
// gateway method is reachable by any admin client, so refuse anything that
// could leave `agents/` rather than trying to normalize it.
function assertSafeAgentId(agentId: string): void {
  if (
    agentId.length === 0 ||
    agentId.includes("/") ||
    agentId.includes("\\") ||
    agentId.includes("..") ||
    agentId.includes("\0")
  ) {
    throw new InvalidRequestError("Invalid agentId: refusing to build a path from it");
  }
}

export function readSessionTrajectory(params: TrajectoryReadParams): TrajectoryReadResult {
  const { stateDir, agentId, sessionKey } = params;
  assertSafeAgentId(agentId);

  const path = join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  // An agent that never ran has no database. Opening one here would create an
  // empty file that OpenClaw then finds without its schema.
  if (!existsSync(path)) return { sessionId: null, jsonl: null };

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    let sessionId = params.sessionId ?? null;
    if (!sessionId && sessionKey) {
      // Exact first, then case-insensitive: OpenClaw lowercases the user
      // segment of the key it stores, and Pinchy builds keys from the user id
      // as the database holds it (`1BCj…` stored as `1bcj…`).
      const row = (db
        .prepare("select current_session_id as id from session_nodes where session_key = ?")
        .get(sessionKey) ??
        db
          .prepare(
            "select current_session_id as id from session_nodes where lower(session_key) = lower(?)"
          )
          .get(sessionKey)) as { id?: unknown } | undefined;
      sessionId = typeof row?.id === "string" && row.id.length > 0 ? row.id : null;
    }
    if (!sessionId) return { sessionId: null, jsonl: null };

    const rows = db
      .prepare("select event_json from trajectory_runtime_events where session_id = ? order by seq")
      .all(sessionId) as Array<{ event_json: string }>;
    return {
      sessionId,
      jsonl: rows.length > 0 ? rows.map((r) => r.event_json).join("\n") + "\n" : null,
    };
  } finally {
    db.close();
  }
}

type Respond = (
  ok: boolean,
  payload?: unknown,
  error?: { code: "INVALID_REQUEST" | "UNAVAILABLE"; message: string }
) => void;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The gateway handler for `pinchy.trajectory.read`. Params: `agentId` plus a
 * `sessionKey` (resolved to the session's current id) or a `sessionId`.
 */
export function createTrajectoryReadMethod(resolveStateDir: () => string) {
  return ({ params, respond }: { params: Record<string, unknown>; respond: Respond }): void => {
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const sessionKey = optionalString(params.sessionKey);
    const sessionId = optionalString(params.sessionId);
    if (!sessionKey && !sessionId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "pinchy.trajectory.read needs a sessionKey or sessionId",
      });
      return;
    }
    try {
      respond(
        true,
        readSessionTrajectory({ stateDir: resolveStateDir(), agentId, sessionKey, sessionId })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, {
        code: err instanceof InvalidRequestError ? "INVALID_REQUEST" : "UNAVAILABLE",
        message,
      });
    }
  };
}

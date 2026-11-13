// Read an OpenClaw session's trajectory: the `openclaw-trajectory` events that
// per-turn usage accounting and the diagnostics export are built from.
//
// Up to OpenClaw 2026.8 the session index (`sessions/sessions.json`) and each
// trajectory (`sessions/<sessionId>.trajectory.jsonl`) were files on the shared
// state volume, and this module read them from Pinchy's mount. OpenClaw 2026.9
// moved both into a per-agent SQLite database it keeps at mode 0600, which
// Pinchy's container cannot read. So the pinchy-audit plugin reads it inside
// the gateway and answers `pinchy.trajectory.read` over the connection Pinchy
// already holds; the answer is the same JSONL the files held, so the parsers
// downstream did not change.

import type { OpenClawClient } from "openclaw-node";
import { getOpenClawClient } from "@/server/openclaw-client";

/** Served by packages/plugins/pinchy-audit/trajectory-reader.ts. */
export const TRAJECTORY_READ_METHOD = "pinchy.trajectory.read";

/** The one client call the readers need, so callers can pass their own client. */
export type TrajectoryRpcClient = Pick<OpenClawClient, "request">;

// The plugin refuses unsafe agent ids itself; checking here too keeps a bad id
// from ever leaving Pinchy, and the sessionId may come from a client request.
function assertSafeSegment(segment: string, kind: string): void {
  if (
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("..") ||
    segment.includes("\0")
  ) {
    throw new Error(`Invalid ${kind}: refusing an unsafe identifier`);
  }
}

/**
 * Thrown when OpenClaw has no trajectory recorded for a session, so callers can
 * tell "nothing to read yet" from a read that failed.
 */
export class TrajectoryFileNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Trajectory not found: ${path}`);
    this.name = "TrajectoryFileNotFoundError";
    this.path = path;
  }
}

interface TrajectoryReadAnswer {
  sessionId: string | null;
  jsonl: string | null;
}

async function readTrajectory(
  client: TrajectoryRpcClient,
  params: { agentId: string; sessionKey?: string; sessionId?: string }
): Promise<TrajectoryReadAnswer> {
  // openclaw-node RESOLVES on an error response rather than rejecting, so the
  // `ok` flag has to be read. A refusal is a failed read, never "no session":
  // reading it as empty would record a turn's usage as zero and say nothing.
  const response = await client.request(TRAJECTORY_READ_METHOD, params);
  if (!response.ok) {
    throw new Error(
      `${TRAJECTORY_READ_METHOD} failed: ${response.error?.message ?? "no reason given"}`
    );
  }
  const payload = response.payload ?? {};
  return {
    sessionId:
      typeof payload.sessionId === "string" && payload.sessionId.length > 0
        ? payload.sessionId
        : null,
    jsonl: typeof payload.jsonl === "string" ? payload.jsonl : null,
  };
}

/**
 * Resolve a sessionKey to the agent's current sessionId for it. Returns null
 * when OpenClaw knows no session under that key. OpenClaw lowercases the user
 * segment of the keys it stores; the plugin matches case-insensitively.
 */
export async function resolveSessionId(
  agentId: string,
  sessionKey: string,
  client?: TrajectoryRpcClient
): Promise<string | null> {
  assertSafeSegment(agentId, "agentId");
  const answer = await readTrajectory(client ?? getOpenClawClient(), { agentId, sessionKey });
  return answer.sessionId;
}

/**
 * Read the trajectory for the given agent and session as JSONL, oldest event
 * first. Throws `TrajectoryFileNotFoundError` when none is recorded; any other
 * failure propagates.
 */
export async function readTrajectoryJsonl(
  agentId: string,
  sessionId: string,
  client?: TrajectoryRpcClient
): Promise<string> {
  assertSafeSegment(agentId, "agentId");
  assertSafeSegment(sessionId, "sessionId");
  const answer = await readTrajectory(client ?? getOpenClawClient(), { agentId, sessionId });
  if (answer.jsonl === null) {
    throw new TrajectoryFileNotFoundError(`agents/${agentId}/sessions/${sessionId}`);
  }
  return answer.jsonl;
}

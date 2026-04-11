import type { OpenClawClient } from "openclaw-node";
import { recordUsage } from "@/lib/usage";
import { db } from "@/db";
import { agents } from "@/db/schema";

const POLL_INTERVAL_MS = 60_000;

export interface ParsedSessionKey {
  agentId: string;
  userId: string;
  type: "chat" | "system";
}

/**
 * Parses an OpenClaw session key into agentId, userId, and type.
 *
 * Key format: `agent:<agentId>:<scope>` where scope is either:
 *   - `direct:<userId>` for browser chat sessions → type "chat"
 *   - `main`, `cron:<jobId>`, `hook:<hookId>`, etc. → type "system"
 *
 * Returns null for unparseable keys.
 */
export function parseSessionKey(key: string): ParsedSessionKey | null {
  const match = /^agent:([^:]+):(.+)$/.exec(key);
  if (!match) return null;

  const agentId = match[1];
  const scope = match[2];
  if (!agentId || !scope) return null;

  // direct:<userId> → chat session. Preserve userId even if it contains colons.
  const directMatch = /^direct:(.+)$/.exec(scope);
  if (directMatch) {
    return { agentId, userId: directMatch[1], type: "chat" };
  }

  // Everything else (main, cron:*, hook:*, etc.) → system usage
  return { agentId, userId: "system", type: "system" };
}

interface SessionListEntry {
  key: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

/**
 * Polls all OpenClaw sessions once and records usage deltas for each
 * session that has tokens. Unknown agent IDs fall back to the ID itself
 * as the agent name. Failures are logged but never thrown — a failed poll
 * just means we try again next tick.
 */
export async function pollAllSessions(openclawClient: OpenClawClient): Promise<void> {
  try {
    const listResult = (await openclawClient.sessions.list()) as {
      sessions?: SessionListEntry[];
    };
    const sessions = listResult?.sessions ?? [];
    if (sessions.length === 0) return;

    // Pre-fetch agent names to avoid one DB round-trip per session.
    const allAgents = await db.select({ id: agents.id, name: agents.name }).from(agents);
    const agentNameMap = new Map(allAgents.map((a) => [a.id, a.name]));

    for (const session of sessions) {
      const hasTokens = (session.inputTokens ?? 0) > 0 || (session.outputTokens ?? 0) > 0;
      if (!hasTokens) continue;

      const parsed = parseSessionKey(session.key);
      if (!parsed) continue;

      const agentName = agentNameMap.get(parsed.agentId) ?? parsed.agentId;

      await recordUsage({
        openclawClient,
        userId: parsed.userId,
        agentId: parsed.agentId,
        agentName,
        sessionKey: session.key,
      });
    }
  } catch (error) {
    console.error("[usage-poller] Poll failed:", error);
  }
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the global usage poller. Idempotent — calling twice is a no-op.
 * The poller gracefully handles disconnects: if sessions.list() fails, the
 * next tick will try again, so no explicit stop is needed on OpenClaw
 * reconnection.
 */
export function startUsagePoller(openclawClient: OpenClawClient): void {
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    pollAllSessions(openclawClient).catch((err) => {
      console.error("[usage-poller] Unexpected error:", err);
    });
  }, POLL_INTERVAL_MS);
}

export function stopUsagePoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/** Exported only for tests. */
export function _isPollerRunning(): boolean {
  return pollInterval !== null;
}

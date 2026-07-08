import type { OpenClawClient } from "openclaw-node";
import { isNull } from "drizzle-orm";
import { recordUsage } from "@/lib/usage";
import { recordSessionTurnsUsage } from "@/lib/usage-per-turn";
import { db } from "@/db";
import { agents, users } from "@/db/schema";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
// Never poll faster than once per second, regardless of the override —
// a misconfigured interval shouldn't let the poller hammer OpenClaw's
// sessions.list() (which is CPU-bound during OC's startup scan).
const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * Resolves the poll interval in milliseconds. Reads
 * `PINCHY_USAGE_POLL_INTERVAL_MS` at call time so test stacks (and ops) can
 * tune polling cadence — the integration E2E stack sets it low so usage rows
 * appear within the test window instead of after the 60s default. Invalid or
 * non-positive values fall back to the default; valid values below the floor
 * are clamped up to it.
 */
export function getPollIntervalMs(): number {
  const raw = process.env.PINCHY_USAGE_POLL_INTERVAL_MS;
  if (raw === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, parsed);
}

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

  // direct:<userId> → chat session. Capture ONLY the userId segment: the chats
  // feature appends a trailing chatId (direct:<userId>:<chatId>), and a greedy
  // capture would fold the chatId into the userId, mis-attributing usage to a
  // bogus id that never matches the users table. The userId never contains a colon.
  const directMatch = /^direct:([^:]+)/.exec(scope);
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
  // OpenClaw's session store names the cache counters `cacheRead`/`cacheWrite`
  // (verified live against OC 2026.5.28). The `*Tokens` spellings are kept as
  // fallback for other OC versions. Reading only the long names left every
  // usage_record with cache=0 while Anthropic served ~97% of input from the
  // prompt cache — the dashboard showed "Input: 7" for a ~400k-token day.
  cacheRead?: number;
  cacheWrite?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

// Adaptive backoff (#261 D): the per-turn trajectory scan (chat sessions) runs
// on every tick regardless of the gauge, and the gauge-delta recordUsage
// (system sessions) re-reads the DB watermark every tick. Both are no-ops when
// nothing changed, so re-running them every 60 s for idle sessions is wasted
// DB/CPU at scale (50 agents × 50 sessions ≈ 2 500 scans/min). We fingerprint
// each session's gauge counters and skip the expensive processing while the
// fingerprint is unchanged, with a periodic catch-up scan every IDLE_RESCAN_MS
// as a backstop (covers the narrow case where two turns carry identical gauge
// counts AND the lower-latency chat `done` path also missed one).
const IDLE_RESCAN_MS = 5 * 60_000;

interface SessionActivity {
  signature: string;
  lastProcessedAt: number;
}
const sessionActivity = new Map<string, SessionActivity>();

/** Exported only for tests — clears the per-session backoff state. */
export function _resetSessionActivity(): void {
  sessionActivity.clear();
}

/**
 * Resolves a session's cache counters from either OC spelling
 * (`cacheRead`/`cacheWrite` vs. `cacheReadTokens`/`cacheWriteTokens` — see the
 * SessionListEntry comment). Left as `undefined`, not defaulted to 0, because
 * callers differ on how they need the "no cache data" case represented.
 */
function resolveCacheCounters(s: SessionListEntry): {
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
} {
  return {
    cacheReadTokens: s.cacheRead ?? s.cacheReadTokens,
    cacheWriteTokens: s.cacheWrite ?? s.cacheWriteTokens,
  };
}

/**
 * Fingerprint of a session's gauge counters. OpenClaw overwrites these each
 * turn, so any change means a turn happened since we last looked; an identical
 * fingerprint means the session was idle. Includes the cache counters (both OC
 * spellings) and the model so a mid-session model switch also counts as change.
 */
function gaugeSignature(s: SessionListEntry): string {
  const { cacheReadTokens, cacheWriteTokens } = resolveCacheCounters(s);
  return `${s.inputTokens ?? 0}|${s.outputTokens ?? 0}|${cacheReadTokens ?? 0}|${cacheWriteTokens ?? 0}|${s.model ?? ""}`;
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
    if (sessions.length === 0) {
      // No live sessions — drop stale backoff state so a returning session is
      // treated as fresh (and the map never grows unbounded).
      sessionActivity.clear();
      return;
    }

    // Pre-fetch agent names to avoid one DB round-trip per session.
    // Skip soft-deleted agents — a stale session key should fall through
    // to the agentId fallback instead of surfacing a deleted agent's name.
    const allAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(isNull(agents.deletedAt));
    const agentNameMap = new Map(allAgents.map((a) => [a.id, a.name]));

    // Pre-fetch user IDs to resolve lowercased session-key IDs back to
    // the original-case DB ID. OpenClaw lowercases session keys, so
    // parseSessionKey extracts a lowercase userId that won't match the
    // users table on a case-sensitive join.
    const allUsers = await db.select({ id: users.id }).from(users);
    const userIdMap = new Map(allUsers.map((u) => [u.id.toLowerCase(), u.id]));

    const now = Date.now();
    const liveKeys = new Set<string>();

    for (const session of sessions) {
      const parsed = parseSessionKey(session.key);
      if (!parsed) continue;
      liveKeys.add(session.key);

      // Adaptive backoff (#261): skip the expensive per-session processing while
      // the gauge fingerprint is unchanged, except for a periodic catch-up scan
      // every IDLE_RESCAN_MS. A changed fingerprint means a turn happened, so we
      // process immediately; DB dedup keeps a catch-up re-scan a no-op.
      const signature = gaugeSignature(session);
      const prev = sessionActivity.get(session.key);
      const changed = !prev || prev.signature !== signature;
      const dueForRescan = !prev || now - prev.lastProcessedAt >= IDLE_RESCAN_MS;
      if (!changed && !dueForRescan) continue;

      const agentName = agentNameMap.get(parsed.agentId) ?? parsed.agentId;

      if (parsed.type === "chat") {
        // Lossless per-turn accounting (#483): chat usage is recorded from the
        // trajectory's exact per-turn `model.completed` events, NOT the gauge
        // counters (which OpenClaw overwrites each turn, so sampling drops
        // turns). This poll is a backstop scan; the chat `done` path scans with
        // lower latency. DB dedup by (sessionKey, runId) makes re-scans no-ops.
        const userId = userIdMap.get(parsed.userId.toLowerCase()) ?? parsed.userId;
        await recordSessionTurnsUsage({
          openclawClient,
          agentId: parsed.agentId,
          userId,
          agentName,
          sessionKey: session.key,
        });
        // Mark as processed only after the record call succeeds — if it threw,
        // the catch below aborts the loop, and the fingerprint must stay
        // unset so the next tick retries this session instead of treating a
        // failed record as done and skipping it until the catch-up rescan.
        sessionActivity.set(session.key, { signature, lastProcessedAt: now });
        continue;
      }

      // System sessions (main/cron/hook/channel) have no per-user trajectory we
      // scan, so they stay on the gauge delta path.
      const { cacheReadTokens, cacheWriteTokens } = resolveCacheCounters(session);
      const hasTokens =
        (session.inputTokens ?? 0) > 0 ||
        (session.outputTokens ?? 0) > 0 ||
        (cacheReadTokens ?? 0) > 0 ||
        (cacheWriteTokens ?? 0) > 0;
      if (!hasTokens) {
        // Nothing to record — this isn't a failure, so it's safe to mark the
        // session processed and let it ride the idle backoff.
        sessionActivity.set(session.key, { signature, lastProcessedAt: now });
        continue;
      }

      await recordUsage({
        openclawClient,
        userId: parsed.userId, // "system"
        agentId: parsed.agentId,
        agentName,
        sessionKey: session.key,
        sessionSnapshot: {
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          model: session.model,
        },
      });
      // Mark as processed only after the record call succeeds (see comment
      // on the chat-session path above for why ordering matters here).
      sessionActivity.set(session.key, { signature, lastProcessedAt: now });
    }

    // Prune backoff state for sessions that no longer exist so the map stays
    // bounded to the set of live sessions.
    for (const key of sessionActivity.keys()) {
      if (!liveKeys.has(key)) sessionActivity.delete(key);
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
  }, getPollIntervalMs());
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

import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import type { OpenClawClient } from "openclaw-node";
import { parseJsonlLines } from "@/lib/diagnostics/jsonl-parser";
import {
  resolveSessionId,
  readTrajectoryJsonl,
  TrajectoryFileNotFoundError,
} from "@/lib/diagnostics/jsonl-reader";
import { extractPerTurnUsage, type PerTurnUsage } from "@/lib/usage-from-trajectory";
import { getModelPricing } from "@/lib/usage";
import { estimateTurnCostUsd, type ModelPricing } from "@/lib/usage-cost";

/**
 * Lossless per-turn token accounting (#483, extended to system sessions by
 * #767). OpenClaw overwrites its per-session token counters every turn, so a
 * gauge poller (which samples those counters on an interval) silently drops
 * turns that complete between polls. Each completed turn instead writes a
 * `model.completed` trajectory event carrying that turn's EXACT token
 * classes; this recorder reads them and inserts one usage_records row per
 * turn, deduped by (sessionKey, runId) at the DB layer so re-scans / restarts
 * / the low-latency chat-`done` trigger are all idempotent. Chat sessions
 * moved to this path under #483; the poller originally kept system sessions
 * (cron/channel/main/hook) on a separate gauge-delta path under the belief
 * that they had "no per-user trajectory to scan" — verified false in
 * production (#767): cron/channel sessions DO have a per-session
 * `<sessionId>.trajectory.jsonl`, so system sessions now go through this same
 * recorder too. That gap meant the autonomous/cron/Telegram runs — exactly
 * the shape of the 2026-07-15 Piper incident — never got a `context_tokens`
 * reading; they do now.
 */

export interface InsertableUsageRow {
  userId: string;
  agentId: string;
  agentName: string;
  sessionKey: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: string | null;
  runId: string;
  seq: number;
  /** Context-window pressure for this turn — see PerTurnUsage.contextTokens. */
  contextTokens: number | null;
}

export interface UsageRowContext {
  userId: string;
  agentId: string;
  agentName: string;
  /** Normalized (lowercased) session key, authoritative for the DB row. */
  sessionKey: string;
}

/**
 * Map extracted per-turn usages to insertable rows. Pure: cost comes from the
 * injected `priceFor` so each turn is priced by its OWN model (a subagent turn
 * can run on a different model than the main turn).
 */
export function buildUsageRows(
  turns: PerTurnUsage[],
  ctx: UsageRowContext,
  priceFor: (model: string | null) => ModelPricing | null
): InsertableUsageRow[] {
  const sessionKey = ctx.sessionKey.toLowerCase();
  return turns.map((t) => {
    const pricing = priceFor(t.model);
    return {
      userId: ctx.userId,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      sessionKey,
      model: t.model,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      estimatedCostUsd: pricing
        ? estimateTurnCostUsd(
            {
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              cacheReadTokens: t.cacheReadTokens,
              cacheWriteTokens: t.cacheWriteTokens,
            },
            pricing
          )
        : null,
      runId: t.runId,
      seq: t.seq,
      contextTokens: t.contextTokens,
    };
  });
}

/**
 * Insert per-turn usage rows idempotently. The unique index
 * uq_usage_session_run(session_key, run_id) makes a repeated (sessionKey,
 * runId) a no-op (gauge/internal rows have run_id NULL and are exempt via
 * Postgres NULLS DISTINCT), so concurrent/duplicate scans never double-count.
 * Returns how many rows were newly inserted.
 */
export async function insertPerTurnUsage(rows: InsertableUsageRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(usageRecords)
    .values(rows)
    .onConflictDoNothing({
      target: [usageRecords.sessionKey, usageRecords.runId],
    })
    .returning({ id: usageRecords.id });
  return inserted.length;
}

export interface RecordSessionTurnsParams {
  openclawClient: OpenClawClient;
  agentId: string;
  userId: string;
  agentName: string;
  sessionKey: string;
  /** Optional: skip the sessions-index lookup if the caller already has it. */
  sessionId?: string;
}

/**
 * Scan one session's trajectory (chat or system) and record any
 * not-yet-recorded turns. Safe to call repeatedly (DB dedup) — from the
 * interval poller and from the chat `done` path.
 *
 * Returns the number of newly recorded turns, or `null` when the scan FAILED
 * and should be retried. The two are deliberately distinct: `0` is a
 * successful scan that found nothing new (the common idle case, and the one
 * the poller's backoff must be allowed to skip), while `null` says nothing is
 * known about this session's turns yet. Collapsing both into `0` let a
 * transient DB/IO error read as "processed" and pushed the retry out to the
 * poller's 5-minute catch-up scan — and left the retry the poller documents
 * (#261) unreachable, since this function never rejects for the poller's
 * `catch` to see.
 *
 * It still never THROWS — the chat `done` path calls it fire-and-forget.
 */
export async function recordSessionTurnsUsage(
  params: RecordSessionTurnsParams
): Promise<number | null> {
  const { openclawClient, agentId, userId, agentName, sessionKey } = params;
  try {
    const sessionId = params.sessionId ?? (await resolveSessionId(agentId, sessionKey));
    if (!sessionId) return 0;

    const jsonl = await readTrajectoryJsonl(agentId, sessionId);
    const turns = extractPerTurnUsage(parseJsonlLines(jsonl));
    if (turns.length === 0) return 0;

    const rows = buildUsageRows(turns, { userId, agentId, agentName, sessionKey }, () => null);
    // Price per distinct model (cached in getModelPricing); attach cost.
    const priced = await Promise.all(
      rows.map(async (row) => {
        if (!row.model) return row;
        const pricing = await getModelPricing(openclawClient, row.model);
        if (!pricing) return row;
        return {
          ...row,
          estimatedCostUsd: estimateTurnCostUsd(
            {
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              cacheReadTokens: row.cacheReadTokens,
              cacheWriteTokens: row.cacheWriteTokens,
            },
            pricing
          ),
        };
      })
    );
    return await insertPerTurnUsage(priced);
  } catch (error) {
    // A session with no trajectory file is an EXPECTED state, not a failure:
    // the run may have died before OpenClaw wrote one (e.g. its model was
    // retired), and there is simply nothing to record. Logging it would repeat
    // on every poll cycle forever (#885) — flooding the container logs and
    // evicting real signal from log-capture's bounded diagnostics ring. Stay
    // quiet; a trajectory that appears later is picked up by the next scan.
    if (error instanceof TrajectoryFileNotFoundError) return 0;
    // Everything else (unreadable file, DB hiccup) is real breakage worth
    // surfacing — but still never thrown into the poller or chat path. `null`
    // (not 0) tells the poller the scan did not happen, so it retries on the
    // next tick instead of riding the idle backoff; dedup keeps that safe.
    console.error("[usage-per-turn] Failed to record session turns:", error);
    return null;
  }
}

import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import type { OpenClawClient } from "openclaw-node";
import { parseJsonlLines } from "@/lib/diagnostics/jsonl-parser";
import { resolveSessionId, readTrajectoryJsonl } from "@/lib/diagnostics/jsonl-reader";
import { extractPerTurnUsage, type PerTurnUsage } from "@/lib/usage-from-trajectory";
import { getModelPricing } from "@/lib/usage";
import { estimateTurnCostUsd, type ModelPricing } from "@/lib/usage-cost";

/**
 * Lossless per-turn token accounting (#483). OpenClaw overwrites its
 * per-session token counters every turn, so the gauge poller (which samples
 * those counters on an interval) silently drops turns that complete between
 * polls. Each completed turn instead writes a `model.completed` trajectory
 * event carrying that turn's EXACT token classes; this recorder reads them and
 * inserts one usage_records row per turn, deduped by (sessionKey, runId) at the
 * DB layer so re-scans / restarts / the low-latency chat-`done` trigger are all
 * idempotent. Chat sessions move to this path; the poller keeps system
 * sessions (cron/channel/main), which have no per-user trajectory we scan.
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
 * Scan one chat session's trajectory and record any not-yet-recorded turns.
 * Safe to call repeatedly (DB dedup) — from the interval poller and from the
 * chat `done` path. Returns the number of newly recorded turns.
 */
export async function recordSessionTurnsUsage(params: RecordSessionTurnsParams): Promise<number> {
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
    // Trajectory missing / unreadable / DB hiccup — never throw into the
    // poller or chat path. The next scan retries; dedup keeps it safe.
    console.error("[usage-per-turn] Failed to record session turns:", error);
    return 0;
  }
}

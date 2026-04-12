import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { eq, sum } from "drizzle-orm";
import type { OpenClawClient } from "openclaw-node";

/**
 * OpenClaw session token snapshot passed from callers that already have
 * one in hand (notably the poller, which fetches sessions.list() once per
 * tick and fans out to recordUsage for each session). If omitted, the
 * implementation does its own sessions.list() round-trip — useful for
 * one-off callers like the "done" event path from the chat route.
 */
export interface SessionTokenSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

interface RecordUsageParams {
  openclawClient: OpenClawClient;
  userId: string;
  agentId: string;
  agentName: string;
  sessionKey: string;
  sessionSnapshot?: SessionTokenSnapshot;
}

// Module-level cache for OpenClaw config pricing
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedPricing: Map<string, { input: number; output: number }> | null = null;
let cacheTimestamp = 0;

/** Exported only for tests — resets the module-level pricing cache. */
export function _resetPricingCacheForTest(): void {
  cachedPricing = null;
  cacheTimestamp = 0;
}

// Per-session serialization to prevent race conditions in delta computation.
// Without this, concurrent recordUsage calls for the same session could read
// stale DB sums and double-count tokens.
const pendingBySession = new Map<string, Promise<void>>();

/** Exported only for tests — resets the per-session serialization map. */
export function _resetPendingSessionsForTest(): void {
  pendingBySession.clear();
}

/** Exported only for tests — reports the serialization map size for leak detection. */
export function _getPendingSessionsCountForTest(): number {
  return pendingBySession.size;
}

// Per-session watermark tracking the LAST OBSERVED OpenClaw cumulative
// counter. This is deliberately distinct from the DB aggregate: OpenClaw
// clears session.inputTokens/outputTokens/cacheRead/cacheWrite on
// compaction, session-reset, and checkpoint clone (verified in
// openclaw/src/gateway/server-methods/sessions.ts and
// session-reset-service.ts). After a reset, `current < db_sum` forever,
// which would make the old DB-sum baseline silently drop every post-reset
// token. The watermark moves backwards with OpenClaw on a reset so the
// next growth is detected correctly.
//
// Watermarks live in memory; after a Pinchy restart the first poll per
// session seeds the watermark from the historical DB aggregate (best
// effort — matches pre-refactor behaviour for the happy path).
interface SessionWatermark {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const sessionWatermarks = new Map<string, SessionWatermark>();

/** Exported only for tests — resets the per-session OpenClaw watermark cache. */
export function _resetUsageWatermarksForTest(): void {
  sessionWatermarks.clear();
}

async function getModelPricing(
  openclawClient: OpenClawClient,
  modelId: string
): Promise<{ input: number; output: number } | null> {
  const now = Date.now();

  if (cachedPricing && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPricing.get(modelId) ?? null;
  }

  const result = (await openclawClient.config.get()) as {
    config?: { models?: { providers?: Record<string, unknown> } };
  };
  const providers = result?.config?.models?.providers ?? {};

  const pricingMap = new Map<string, { input: number; output: number }>();
  for (const provider of Object.values(providers) as Array<{
    models?: Array<{ id: string; cost?: { input: number; output: number } }>;
  }>) {
    for (const model of provider.models ?? []) {
      if (model.cost) {
        pricingMap.set(model.id, model.cost);
      }
    }
  }

  cachedPricing = pricingMap;
  cacheTimestamp = now;

  return pricingMap.get(modelId) ?? null;
}

export async function recordUsage(params: RecordUsageParams): Promise<void> {
  const { sessionKey } = params;
  // Normalize to lowercase to match OpenClaw's key format
  const normalizedKey = sessionKey.toLowerCase();

  // Chain calls for the same session to prevent concurrent delta computation.
  // The .finally() tail deletes the map entry once this call is done — but
  // only if no later call has already replaced it, otherwise we'd strand a
  // chained follow-up with no serialization anchor.
  const prev = pendingBySession.get(normalizedKey) ?? Promise.resolve();
  const next: Promise<void> = prev
    .then(() => recordUsageImpl(params, normalizedKey))
    .catch(() => {})
    .finally(() => {
      if (pendingBySession.get(normalizedKey) === next) {
        pendingBySession.delete(normalizedKey);
      }
    });
  pendingBySession.set(normalizedKey, next);
  return next;
}

async function recordUsageImpl(params: RecordUsageParams, normalizedKey: string): Promise<void> {
  try {
    const { openclawClient, userId, agentId, agentName, sessionSnapshot } = params;

    // Prefer the caller-supplied snapshot (poller already fetched it) to
    // avoid a duplicate sessions.list() round-trip. Fall back to fetching
    // ourselves when called from one-off paths like the chat "done" event.
    let session: SessionTokenSnapshot | undefined = sessionSnapshot;
    if (!session) {
      const listResult = (await openclawClient.sessions.list()) as {
        sessions?: Array<{
          key: string;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          model?: string;
        }>;
      };
      const sessions = listResult?.sessions ?? [];
      session = sessions.find((s) => s.key === normalizedKey);
    }

    if (!session) {
      return;
    }

    const currentInput = session.inputTokens ?? 0;
    const currentOutput = session.outputTokens ?? 0;
    const currentCacheRead = session.cacheReadTokens ?? 0;
    const currentCacheWrite = session.cacheWriteTokens ?? 0;

    // Resolve the baseline for this session. The watermark is the LAST
    // OBSERVED OpenClaw cumulative counter — NOT the historical DB sum.
    // On a cache miss (first poll for this session, or after a Pinchy
    // restart), seed from the DB aggregate as a best-effort baseline: in
    // the happy path that matches the pre-refactor behaviour; in the
    // post-reset-during-downtime edge case we may miss a few tokens, but
    // never double-count.
    let watermark = sessionWatermarks.get(normalizedKey);
    if (!watermark) {
      const [prevSum] = await db
        .select({
          totalInput: sum(usageRecords.inputTokens),
          totalOutput: sum(usageRecords.outputTokens),
          totalCacheRead: sum(usageRecords.cacheReadTokens),
          totalCacheWrite: sum(usageRecords.cacheWriteTokens),
        })
        .from(usageRecords)
        .where(eq(usageRecords.sessionKey, normalizedKey));

      watermark = {
        input: Number(prevSum?.totalInput ?? 0),
        output: Number(prevSum?.totalOutput ?? 0),
        cacheRead: Number(prevSum?.totalCacheRead ?? 0),
        cacheWrite: Number(prevSum?.totalCacheWrite ?? 0),
      };
    }

    // Per-axis clamped delta. Clamping is the safety net for mixed-axis
    // updates (input grows, output drops) where the watermark from one
    // axis alone would otherwise produce a negative insert and corrupt
    // downstream sum() aggregates on the dashboard.
    const deltaInput = Math.max(0, currentInput - watermark.input);
    const deltaOutput = Math.max(0, currentOutput - watermark.output);
    const deltaCacheRead = Math.max(0, currentCacheRead - watermark.cacheRead);
    const deltaCacheWrite = Math.max(0, currentCacheWrite - watermark.cacheWrite);

    // Skip if no axis grew — nothing new to record.
    // Still follow OpenClaw's counter downward on compaction/reset so
    // the next growth is detected correctly.
    if (deltaInput === 0 && deltaOutput === 0 && deltaCacheRead === 0 && deltaCacheWrite === 0) {
      sessionWatermarks.set(normalizedKey, {
        input: currentInput,
        output: currentOutput,
        cacheRead: currentCacheRead,
        cacheWrite: currentCacheWrite,
      });
      return;
    }

    // Estimate cost from model pricing config
    let estimatedCostUsd: string | null = null;
    const model = session.model ?? null;
    try {
      if (model) {
        const pricing = await getModelPricing(openclawClient, model);
        if (pricing) {
          // Cache pricing defaults: Anthropic-style ratios (OpenClaw config lacks cache-specific pricing)
          const cacheReadPrice = pricing.input * 0.1;
          const cacheWritePrice = pricing.input * 1.25;
          const cost =
            (deltaInput * pricing.input +
              deltaOutput * pricing.output +
              deltaCacheRead * cacheReadPrice +
              deltaCacheWrite * cacheWritePrice) /
            1_000_000;
          estimatedCostUsd = cost.toFixed(6);
        }
      }
    } catch (costError) {
      console.error("[usage] Failed to estimate cost, recording usage without cost:", costError);
    }

    await db.insert(usageRecords).values({
      userId,
      agentId,
      agentName,
      sessionKey: normalizedKey,
      model,
      inputTokens: deltaInput,
      outputTokens: deltaOutput,
      cacheReadTokens: deltaCacheRead,
      cacheWriteTokens: deltaCacheWrite,
      estimatedCostUsd,
    });

    // Advance watermark only AFTER successful DB insert. If the insert
    // failed, the next call re-attempts with the same delta — no tokens lost.
    sessionWatermarks.set(normalizedKey, {
      input: currentInput,
      output: currentOutput,
      cacheRead: currentCacheRead,
      cacheWrite: currentCacheWrite,
    });
  } catch (error) {
    console.error("[usage] Failed to record usage:", error);
  }
}

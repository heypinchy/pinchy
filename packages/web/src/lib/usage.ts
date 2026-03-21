import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { eq, sum } from "drizzle-orm";
import type { OpenClawClient } from "openclaw-node";

interface RecordUsageParams {
  openclawClient: OpenClawClient;
  userId: string;
  agentId: string;
  agentName: string;
  sessionKey: string;
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

async function getModelPricing(
  openclawClient: OpenClawClient,
  modelId: string
): Promise<{ input: number; output: number } | null> {
  const now = Date.now();

  if (cachedPricing && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPricing.get(modelId) ?? null;
  }

  const result = await openclawClient.config.get();
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
  try {
    const { openclawClient, userId, agentId, agentName, sessionKey } = params;

    // Get current cumulative token counts from OpenClaw
    const { sessions } = await openclawClient.sessions.list();
    const session = sessions.find((s: { key: string }) => s.key === sessionKey);

    if (!session) {
      return;
    }

    const currentInput = session.inputTokens ?? 0;
    const currentOutput = session.outputTokens ?? 0;
    const currentCacheRead = session.cacheReadTokens ?? 0;
    const currentCacheWrite = session.cacheWriteTokens ?? 0;

    // Get sum of all previously recorded deltas for this session
    const [prev] = await db
      .select({
        totalInput: sum(usageRecords.inputTokens),
        totalOutput: sum(usageRecords.outputTokens),
        totalCacheRead: sum(usageRecords.cacheReadTokens),
        totalCacheWrite: sum(usageRecords.cacheWriteTokens),
      })
      .from(usageRecords)
      .where(eq(usageRecords.sessionKey, sessionKey));

    const prevInput = Number(prev?.totalInput ?? 0);
    const prevOutput = Number(prev?.totalOutput ?? 0);
    const prevCacheRead = Number(prev?.totalCacheRead ?? 0);
    const prevCacheWrite = Number(prev?.totalCacheWrite ?? 0);

    const deltaInput = currentInput - prevInput;
    const deltaOutput = currentOutput - prevOutput;
    const deltaCacheRead = currentCacheRead - prevCacheRead;
    const deltaCacheWrite = currentCacheWrite - prevCacheWrite;

    // Skip if no meaningful token usage
    if (deltaInput <= 0 && deltaOutput <= 0) {
      return;
    }

    // Estimate cost from model pricing config
    let estimatedCostUsd: string | null = null;
    const model = session.model ?? null;
    if (model) {
      const pricing = await getModelPricing(openclawClient, model);
      if (pricing) {
        const cost =
          (deltaInput * pricing.input) / 1_000_000 + (deltaOutput * pricing.output) / 1_000_000;
        estimatedCostUsd = cost.toFixed(6);
      }
    }

    await db.insert(usageRecords).values({
      userId,
      agentId,
      agentName,
      sessionKey,
      model,
      inputTokens: deltaInput,
      outputTokens: deltaOutput,
      cacheReadTokens: deltaCacheRead,
      cacheWriteTokens: deltaCacheWrite,
      estimatedCostUsd,
    });
  } catch (error) {
    console.error("[usage] Failed to record usage:", error);
  }
}

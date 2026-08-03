import type { OpenClawClient } from "openclaw-node";

// Module-level cache for OpenClaw config pricing
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedPricing: Map<string, { input: number; output: number }> | null = null;
let cacheTimestamp = 0;

/** Exported only for tests — resets the module-level pricing cache. */
export function _resetPricingCacheForTest(): void {
  cachedPricing = null;
  cacheTimestamp = 0;
}

export async function getModelPricing(
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

  // Key every model under BOTH shapes its callers ask with. The config itself
  // only carries the bare id, but the per-turn recorder asks with the
  // trajectory's `<provider>/<modelId>` (model.completed events keep provider
  // and modelId in separate fields). Keying bare-only silently priced every
  // chat turn at null. Where two providers share a bare id, the last one wins —
  // unchanged from before; the qualified key disambiguates those callers that
  // supply it.
  const pricingMap = new Map<string, { input: number; output: number }>();
  for (const [providerName, provider] of Object.entries(providers) as Array<
    [string, { models?: Array<{ id: string; cost?: { input: number; output: number } }> }]
  >) {
    for (const model of provider.models ?? []) {
      if (model.cost) {
        pricingMap.set(`${providerName}/${model.id}`, model.cost);
        pricingMap.set(model.id, model.cost);
      }
    }
  }

  cachedPricing = pricingMap;
  cacheTimestamp = now;

  return pricingMap.get(modelId) ?? null;
}

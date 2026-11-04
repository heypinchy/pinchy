import { describe, it, expect, vi, beforeEach } from "vitest";

import { getModelPricing, _resetPricingCacheForTest } from "@/lib/usage";

function makeOpenClawClient(configResponse: unknown): Parameters<typeof getModelPricing>[0] {
  return {
    config: {
      get: vi.fn().mockResolvedValue(configResponse),
    },
  } as unknown as Parameters<typeof getModelPricing>[0];
}

// Regression guard for a silent, production-confirmed pricing gap (2026-07-15).
//
// Pinchy emits every model into the OpenClaw config keyed by its BARE id
// (openclaw-config/build.ts: `id: m.id`), but the per-turn usage path
// (usage-per-turn.ts) asks with the trajectory's fully-qualified
// `<provider>/<modelId>` ("ollama-cloud/kimi-k2.6"), because `model.completed`
// events carry a separate `provider` field.
//
// Only the bare form ever matched, so EVERY chat turn silently recorded
// `estimated_cost_usd = NULL`. Production bore this out exactly: 330/330
// per-turn rows had no cost. It stayed invisible because Ollama Cloud is
// subscription-priced (cost 0), but on a per-token provider it would
// under-report chat spend as zero.
//
// It slipped through because `buildUsageRows` — the only tested unit — takes an
// INJECTED `priceFor`, so the real lookup was never exercised. `getModelPricing`
// therefore keys every model under BOTH the qualified and the bare form.
describe("getModelPricing model-id resolution", () => {
  const configWithPricing = {
    config: {
      models: {
        providers: {
          "ollama-cloud": {
            models: [{ id: "deepseek-v4-pro", cost: { input: 1, output: 2 } }],
          },
        },
      },
    },
  };

  beforeEach(() => {
    _resetPricingCacheForTest();
  });

  it("resolves a bare model id", async () => {
    const client = makeOpenClawClient(configWithPricing);
    await expect(getModelPricing(client, "deepseek-v4-pro")).resolves.toEqual({
      input: 1,
      output: 2,
    });
  });

  it("resolves a fully-qualified <provider>/<modelId> (per-turn path)", async () => {
    const client = makeOpenClawClient(configWithPricing);
    await expect(getModelPricing(client, "ollama-cloud/deepseek-v4-pro")).resolves.toEqual({
      input: 1,
      output: 2,
    });
  });

  it("returns null for a known provider but unknown model", async () => {
    const client = makeOpenClawClient(configWithPricing);
    await expect(getModelPricing(client, "ollama-cloud/no-such-model")).resolves.toBeNull();
  });

  it("does not resolve a model attributed to the wrong provider", async () => {
    const client = makeOpenClawClient(configWithPricing);
    await expect(getModelPricing(client, "anthropic/deepseek-v4-pro")).resolves.toBeNull();
  });
});

// Regression pin, not new behaviour: getModelPricing has always returned the
// configured `cost` object verbatim, so it already carries `tieredPricing`.
// The prompt-length tiers of Claude Haiku 5.5 depend on that — a lookup that
// one day picks out only input/output would silently price every long prompt
// at the short-prompt rate, and this test is what notices.
describe("getModelPricing tiered pricing", () => {
  beforeEach(() => {
    _resetPricingCacheForTest();
  });

  it("passes a model's tieredPricing through", async () => {
    const tieredPricing = [
      { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, range: [0, 100001] },
      { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, range: [100001] },
    ];
    const client = makeOpenClawClient({
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                { id: "claude-haiku-5-5", cost: { input: 0.1, output: 0.5, tieredPricing } },
              ],
            },
          },
        },
      },
    });
    await expect(getModelPricing(client, "anthropic/claude-haiku-5-5")).resolves.toEqual({
      input: 0.1,
      output: 0.5,
      tieredPricing,
    });
  });
});

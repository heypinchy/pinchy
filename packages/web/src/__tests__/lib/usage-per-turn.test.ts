import { describe, it, expect, vi, beforeEach } from "vitest";

const mockValues = vi.fn();
const mockResolveSessionId = vi.fn();
const mockReadTrajectoryJsonl = vi.fn();

vi.mock("@/db", () => ({
  db: { insert: () => ({ values: mockValues }) },
}));

vi.mock("@/db/schema", () => ({
  usageRecords: { _table: "usage_records", sessionKey: "session_key", runId: "run_id" },
}));

vi.mock("@/lib/diagnostics/jsonl-reader", () => ({
  resolveSessionId: (...args: unknown[]) => mockResolveSessionId(...args),
  readTrajectoryJsonl: (...args: unknown[]) => mockReadTrajectoryJsonl(...args),
}));

import { buildUsageRows, recordSessionTurnsUsage } from "@/lib/usage-per-turn";
import { _resetPricingCacheForTest } from "@/lib/usage";
import type { PerTurnUsage } from "@/lib/usage-from-trajectory";

const ctx = {
  userId: "u1",
  agentId: "a1",
  agentName: "Ada",
  sessionKey: "agent:a1:direct:u1",
};

function turn(over: Partial<PerTurnUsage> = {}): PerTurnUsage {
  return {
    runId: "run-1",
    seq: 5,
    sessionId: "sess-1",
    sessionKey: "agent:a1:direct:u1",
    model: "anthropic/claude-sonnet-4-6",
    inputTokens: 5,
    outputTokens: 630,
    cacheReadTokens: 32336,
    cacheWriteTokens: 16956,
    ...over,
  };
}

describe("buildUsageRows", () => {
  it("maps a per-turn usage into an insertable row with attribution, runId/seq, and cost", () => {
    const rows = buildUsageRows([turn()], ctx, () => ({ input: 3, output: 15 }));
    expect(rows).toEqual([
      {
        userId: "u1",
        agentId: "a1",
        agentName: "Ada",
        sessionKey: "agent:a1:direct:u1",
        model: "anthropic/claude-sonnet-4-6",
        inputTokens: 5,
        outputTokens: 630,
        cacheReadTokens: 32336,
        cacheWriteTokens: 16956,
        // (5*3 + 630*15 + 32336*0.3 + 16956*3.75) / 1e6
        estimatedCostUsd: "0.082751",
        runId: "run-1",
        seq: 5,
      },
    ]);
  });

  it("prices each turn by its OWN model (a subagent turn can use a different model)", () => {
    const rows = buildUsageRows(
      [
        turn({ runId: "main", model: "anthropic/claude-sonnet-4-6" }),
        turn({
          runId: "sub",
          model: "ollama-cloud/deepseek-v4-flash",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      ],
      ctx,
      (model) =>
        model?.startsWith("anthropic/") ? { input: 3, output: 15 } : { input: 0, output: 0 }
    );
    expect(rows.map((r) => [r.runId, r.estimatedCostUsd])).toEqual([
      ["main", "0.082751"],
      ["sub", "0.000000"],
    ]);
  });

  it("records null cost when no pricing is known (e.g. local model)", () => {
    const rows = buildUsageRows([turn({ model: "ollama/llama" })], ctx, () => null);
    expect(rows[0].estimatedCostUsd).toBeNull();
    expect(rows[0].inputTokens).toBe(5);
  });

  it("uses the context sessionKey (normalized), not the raw event one", () => {
    const rows = buildUsageRows([turn({ sessionKey: "AGENT:A1:DIRECT:U1" })], ctx, () => null);
    expect(rows[0].sessionKey).toBe("agent:a1:direct:u1");
  });
});

// Seam test. `buildUsageRows` above is pure and takes an INJECTED `priceFor`,
// so all of its cost assertions pass regardless of whether the real lookup
// works — which is exactly how the 2026-07-15 gap survived: every chat turn
// recorded a null cost in production while these tests stayed green. This
// test deliberately does NOT mock `getModelPricing`; it drives the real
// trajectory → model-id → config-pricing chain end to end.
describe("recordSessionTurnsUsage cost wiring", () => {
  // One `model.completed` event in OpenClaw's real shape: `provider` and
  // `modelId` are separate fields, which extractPerTurnUsage joins into the
  // qualified "ollama-cloud/deepseek-v4-pro" the pricing lookup must resolve.
  const trajectory = JSON.stringify({
    type: "model.completed",
    runId: "run-1",
    seq: 1,
    sessionId: "sess-1",
    sessionKey: "agent:a1:direct:u1",
    provider: "ollama-cloud",
    modelId: "deepseek-v4-pro",
    data: { usage: { input: 1000, output: 500, total: 1500 } },
  });

  // Pinchy emits models keyed by their bare id — see openclaw-config/build.ts.
  const config = {
    config: {
      models: {
        providers: {
          "ollama-cloud": {
            models: [{ id: "deepseek-v4-pro", cost: { input: 3, output: 15 } }],
          },
        },
      },
    },
  };

  function client() {
    return {
      config: { get: vi.fn().mockResolvedValue(config) },
    } as unknown as Parameters<typeof recordSessionTurnsUsage>[0]["openclawClient"];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPricingCacheForTest();
    mockResolveSessionId.mockResolvedValue("sess-1");
    mockReadTrajectoryJsonl.mockResolvedValue(trajectory);
    mockValues.mockImplementation((rows: unknown[]) => ({
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve(rows.map((_, i) => ({ id: String(i) }))),
      }),
    }));
  });

  it("attaches a cost to a chat turn whose trajectory model is fully qualified", async () => {
    const recorded = await recordSessionTurnsUsage({
      openclawClient: client(),
      agentId: "a1",
      userId: "u1",
      agentName: "Ada",
      sessionKey: "agent:a1:direct:u1",
    });

    expect(recorded).toBe(1);
    const rows = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows[0].model).toBe("ollama-cloud/deepseek-v4-pro");
    expect(rows[0].estimatedCostUsd).not.toBeNull();
  });

  it("still records the turn with a null cost when the model is unpriced", async () => {
    mockReadTrajectoryJsonl.mockResolvedValue(
      JSON.stringify({
        type: "model.completed",
        runId: "run-2",
        seq: 1,
        sessionId: "sess-1",
        sessionKey: "agent:a1:direct:u1",
        provider: "ollama-local",
        modelId: "llama-unknown",
        data: { usage: { input: 10, output: 5, total: 15 } },
      })
    );

    const recorded = await recordSessionTurnsUsage({
      openclawClient: client(),
      agentId: "a1",
      userId: "u1",
      agentName: "Ada",
      sessionKey: "agent:a1:direct:u1",
    });

    expect(recorded).toBe(1);
    const rows = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows[0].estimatedCostUsd).toBeNull();
  });
});

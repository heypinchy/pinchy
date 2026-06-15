import { describe, it, expect } from "vitest";
import { buildUsageRows } from "@/lib/usage-per-turn";
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

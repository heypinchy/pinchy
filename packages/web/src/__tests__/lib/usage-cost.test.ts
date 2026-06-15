import { describe, it, expect } from "vitest";
import { estimateTurnCostUsd } from "@/lib/usage-cost";

describe("estimateTurnCostUsd", () => {
  const pricing = { input: 3, output: 15 }; // $/M tokens (claude-sonnet-ish)

  it("prices input + output", () => {
    // (1_000_000*3 + 1_000_000*15) / 1e6 = 18
    expect(
      estimateTurnCostUsd(
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        pricing
      )
    ).toBe("18.000000");
  });

  it("prices cache read at 0.1x and cache write at 1.25x the input price", () => {
    // cacheRead: 1e6 * 0.3 = 0.3 ; cacheWrite: 1e6 * 3.75 = 3.75 → 4.05
    expect(
      estimateTurnCostUsd(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
        },
        pricing
      )
    ).toBe("4.050000");
  });

  it("returns 0 for an all-zero turn", () => {
    expect(
      estimateTurnCostUsd(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        pricing
      )
    ).toBe("0.000000");
  });
});

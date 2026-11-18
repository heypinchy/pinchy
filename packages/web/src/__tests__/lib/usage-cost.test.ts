import { describe, it, expect } from "vitest";
import { estimateTurnCostUsd, type ModelPricing } from "@/lib/usage-cost";

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

// Claude Haiku 5.5 has two rate cards, picked by the length of each request's
// prompt — cache reads and writes included (platform.claude.com/docs/en/
// about-claude/pricing, "Long context pricing"). A flat price undercounts every
// long prompt by 5x, and budgets enforce on this number, so an agent could
// overrun its budget fivefold without it showing. The tiers use OpenClaw's
// `tieredPricing` shape (half-open ranges: start <= tokens < end).
describe("estimateTurnCostUsd with prompt-length tiers", () => {
  const haiku55: ModelPricing = {
    input: 0.1,
    output: 0.5,
    tieredPricing: [
      { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, range: [0, 100001] },
      { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, range: [100001] },
    ],
  };
  const oneMillionEach = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };

  it("prices a prompt of up to 100,000 tokens at the short-prompt card", () => {
    // 0.1 + 0.5 + 0.01 + 0.125
    expect(estimateTurnCostUsd(oneMillionEach, haiku55, 100_000)).toBe("0.735000");
  });

  it("prices a prompt over 100,000 tokens at the long-prompt card", () => {
    // 0.5 + 2.5 + 0.05 + 0.625
    expect(estimateTurnCostUsd(oneMillionEach, haiku55, 100_001)).toBe("3.675000");
  });

  it("falls back to the flat price when the prompt size is unknown", () => {
    // 0.1 + 0.5 + 0.1 * 0.1 + 0.1 * 1.25 — the untiered formula
    expect(estimateTurnCostUsd(oneMillionEach, haiku55, null)).toBe("0.735000");
  });
});

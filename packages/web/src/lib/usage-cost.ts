/**
 * Pure USD cost estimate for a set of token classes — the single source of
 * truth shared by the gauge poller (system sessions) and the per-turn recorder
 * (#483 chat sessions). OpenClaw's model config carries only input/output
 * prices, so cache classes use Anthropic-style ratios: a cache READ is 10% of
 * the input price, a cache WRITE is 125%.
 */
export interface ModelPricing {
  input: number;
  output: number;
}

export interface TokenClasses {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function estimateTurnCostUsd(tokens: TokenClasses, pricing: ModelPricing): string {
  const cacheReadPrice = pricing.input * 0.1;
  const cacheWritePrice = pricing.input * 1.25;
  const cost =
    (tokens.inputTokens * pricing.input +
      tokens.outputTokens * pricing.output +
      tokens.cacheReadTokens * cacheReadPrice +
      tokens.cacheWriteTokens * cacheWritePrice) /
    1_000_000;
  return cost.toFixed(6);
}

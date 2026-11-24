/**
 * Pure USD cost estimate for a set of token classes — the single source of
 * truth for the per-turn recorder, which prices every session's turns (#483
 * chat, #767 system). At a flat price, cache classes use Anthropic-style
 * ratios: a cache READ is 10% of the input price, a cache WRITE is 125% (a
 * model's own cacheRead/cacheWrite are not read on this path).
 *
 * A model priced by prompt length (Claude Haiku 5.5) also carries
 * `tieredPricing`, in OpenClaw's shape: half-open token ranges
 * (`start <= promptTokens < end`, an open end for the last tier), each with its
 * own four rates. The tier is picked by the prompt the model read — input plus
 * cache reads and writes, the way Anthropic counts it.
 */
export interface PricingTier {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  range: [number, number] | [number];
}

export interface ModelPricing {
  input: number;
  output: number;
  tieredPricing?: PricingTier[];
}

export interface TokenClasses {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function tierFor(tiers: PricingTier[], promptTokens: number): PricingTier | undefined {
  return tiers.find(
    ({ range: [start, end] }) => promptTokens >= start && (end === undefined || promptTokens < end)
  );
}

/**
 * `promptTokens` is the size of the prompt that selects a tier; `null` or
 * omitted (unknown) prices at the flat `input`/`output` rates.
 */
export function estimateTurnCostUsd(
  tokens: TokenClasses,
  pricing: ModelPricing,
  promptTokens?: number | null
): string {
  const tier =
    pricing.tieredPricing && promptTokens != null
      ? tierFor(pricing.tieredPricing, promptTokens)
      : undefined;
  // The flat 10% / 125% cache ratios hold for every model the catalog prices
  // today. They do NOT hold for Opus 5.5 and Sonnet 5.5 (cache reads at 5% of
  // input) or Fable 5.1 (2.5%) — platform.claude.com/docs/en/about-claude/
  // pricing, footnotes 1 and 2, read 2026-11-04. When those models unlock with
  // the runtime update (#1225), read the model's own cacheRead/cacheWrite here.
  const rates = tier ?? {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.input * 0.1,
    cacheWrite: pricing.input * 1.25,
  };
  const cost =
    (tokens.inputTokens * rates.input +
      tokens.outputTokens * rates.output +
      tokens.cacheReadTokens * rates.cacheRead +
      tokens.cacheWriteTokens * rates.cacheWrite) /
    1_000_000;
  return cost.toFixed(6);
}

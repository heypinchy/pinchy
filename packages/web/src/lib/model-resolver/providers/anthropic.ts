import type { ModelHint, ModelTier, ResolverResult } from "../types";

const TIER_MAP: Record<ModelTier, string> = {
  fast: "anthropic/claude-haiku-4-5-20251001",
  balanced: "anthropic/claude-sonnet-4-6",
  reasoning: "anthropic/claude-opus-4-6",
};

export function resolveAnthropic(hint: ModelHint): ResolverResult {
  const model = TIER_MAP[hint.tier];
  return {
    model,
    reason: `anthropic: tier=${hint.tier} → ${model.split("/")[1]}`,
    fallbackUsed: false,
  };
}

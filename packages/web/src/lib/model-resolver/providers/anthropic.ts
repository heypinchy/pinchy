import type { ModelHint, ModelTier, ResolverResult } from "../types";

// Fable 5.1 is deliberately no tier's pick: at $10/$50 per MTok it costs 2.5×
// Opus 5.5, and a template's tier is a default nobody chose. It stays one
// click away in the agent's model settings.
const TIER_MAP: Record<ModelTier, string> = {
  fast: "anthropic/claude-haiku-5-5",
  balanced: "anthropic/claude-sonnet-5-5",
  reasoning: "anthropic/claude-opus-5-5",
};

export function resolveAnthropic(hint: ModelHint): ResolverResult {
  const model = TIER_MAP[hint.tier];
  return {
    model,
    reason: `anthropic: tier=${hint.tier} → ${model.split("/")[1]}`,
    fallbackUsed: false,
  };
}

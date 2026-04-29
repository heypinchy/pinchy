import type { ModelHint, ModelTier, ResolverResult } from "../types";

const TIER_MAP: Record<ModelTier, string> = {
  fast: "openai/gpt-5.4-mini",
  balanced: "openai/gpt-5.4",
  reasoning: "openai/gpt-5.5",
};

export function resolveOpenAI(hint: ModelHint): ResolverResult {
  const model = TIER_MAP[hint.tier];
  return {
    model,
    reason: `openai: tier=${hint.tier} → ${model.split("/")[1]}`,
    fallbackUsed: false,
  };
}

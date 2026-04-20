import type { ModelHint, ModelTier, ResolverResult } from "../types";

const TIER_MAP: Record<ModelTier, string> = {
  fast: "openai/gpt-4o-mini",
  balanced: "openai/gpt-4o",
  reasoning: "openai/o3",
};

export function resolveOpenAI(hint: ModelHint): ResolverResult {
  const model = TIER_MAP[hint.tier];
  return {
    model,
    reason: `openai: tier=${hint.tier} → ${model.split("/")[1]}`,
    fallbackUsed: false,
  };
}

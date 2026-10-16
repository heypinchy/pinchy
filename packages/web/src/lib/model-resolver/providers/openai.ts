import type { ModelHint, ModelTier, ResolverResult } from "../types";

// GPT-6 Astra is OpenAI's $10/$50 tier — the counterpart of Anthropic's Fable,
// and opt-in for the same reason. Sol, "near-Astra at a lower cost", covers
// reasoning as well as balanced, as gpt-5.5 did before it.
const TIER_MAP: Record<ModelTier, string> = {
  fast: "openai/gpt-6-luna",
  balanced: "openai/gpt-6.1-sol",
  reasoning: "openai/gpt-6.1-sol",
};

export function resolveOpenAI(hint: ModelHint): ResolverResult {
  const model = TIER_MAP[hint.tier];
  return {
    model,
    reason: `openai: tier=${hint.tier} → ${model.split("/")[1]}`,
    fallbackUsed: false,
  };
}

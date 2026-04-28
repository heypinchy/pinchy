import type { ModelHint, ModelTier, ResolverResult } from "../types";

const TIER_MAP: Record<ModelTier, string> = {
  fast: "google/gemini-2.5-flash-lite",
  balanced: "google/gemini-2.5-flash",
  reasoning: "google/gemini-2.5-pro",
};

export function resolveGoogle(hint: ModelHint): ResolverResult {
  const model = TIER_MAP[hint.tier];
  return {
    model,
    reason: `google: tier=${hint.tier} → ${model.split("/")[1]}`,
    fallbackUsed: false,
  };
}

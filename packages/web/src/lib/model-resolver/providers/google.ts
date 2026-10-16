import type { ModelHint, ModelTier, ResolverResult } from "../types";

// Google stopped shipping a "Pro" model: Gemini 3.8 Flash is its balanced
// model, Gemini 4 Argon its reasoning flagship.
const TIER_MAP: Record<ModelTier, string> = {
  fast: "google/gemini-3.5-flash-lite",
  balanced: "google/gemini-3.8-flash",
  reasoning: "google/gemini-4-argon",
};

export function resolveGoogle(hint: ModelHint): ResolverResult {
  const model = TIER_MAP[hint.tier];
  return {
    model,
    reason: `google: tier=${hint.tier} → ${model.split("/")[1]}`,
    fallbackUsed: false,
  };
}

import type { ModelHint, ModelTier, ResolverResult } from "../types";

// Sonnet 5 rather than the newer Sonnet 5.5: the agent runtime this release
// ships (OpenClaw 2026.7.1) predates the Claude 5.5 request contract, and the
// 5.5 models are tools-blocked until it is updated (see blocklist.ts).
const TIER_MAP: Record<ModelTier, string> = {
  fast: "anthropic/claude-haiku-4-5-20251001",
  balanced: "anthropic/claude-sonnet-5",
  reasoning: "anthropic/claude-opus-4-7",
};

export function resolveAnthropic(hint: ModelHint): ResolverResult {
  const model = TIER_MAP[hint.tier];
  return {
    model,
    reason: `anthropic: tier=${hint.tier} → ${model.split("/")[1]}`,
    fallbackUsed: false,
  };
}

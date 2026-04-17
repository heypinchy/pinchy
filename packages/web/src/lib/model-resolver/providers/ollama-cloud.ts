import type { ModelHint, ModelTaskType, ModelTier, ResolverResult } from "../types";

const BY_TIER_FAMILY: Record<
  ModelTier,
  Partial<Record<ModelTaskType, string>> & { general: string }
> = {
  fast: {
    general: "ollama-cloud/gemini-2.0-flash",
    coder: "ollama-cloud/qwen3-coder:30b",
  },
  balanced: {
    general: "ollama-cloud/llama3.3:70b",
    coder: "ollama-cloud/qwen3-coder:30b",
    vision: "ollama-cloud/qwen3-vl:32b",
  },
  reasoning: {
    general: "ollama-cloud/deepseek-v3",
    reasoning: "ollama-cloud/deepseek-r1:32b",
  },
};

export function resolveOllamaCloud(hint: ModelHint): ResolverResult {
  const tierMap = BY_TIER_FAMILY[hint.tier];
  const taskType = hint.taskType ?? "general";
  const exactMatch = tierMap[taskType];
  const model = exactMatch ?? tierMap.general;
  const fallbackUsed = !exactMatch;
  return {
    model,
    reason: `ollama-cloud: tier=${hint.tier}, taskType=${taskType} → ${model}`,
    fallbackUsed,
  };
}

import type { ModelHint, ModelTaskType, ModelTier, ResolverResult } from "../types";
import type { OllamaCloudModelId } from "@/lib/ollama-cloud-models";

// `OllamaCloudModelId` is a literal-string union derived from the curated
// list in `ollama-cloud-models.ts`. By typing each entry as
// `ollama-cloud/${OllamaCloudModelId}`, any stale or removed model ID
// becomes a TypeScript compile error — the v0.5.0 staging bug
// (`llama3.3:70b → HTTP 404`) would have failed `tsc` here.
type OllamaCloudModelRef = `ollama-cloud/${OllamaCloudModelId}`;

const BY_TIER_FAMILY: Record<
  ModelTier,
  Partial<Record<ModelTaskType, OllamaCloudModelRef>> & { general: OllamaCloudModelRef }
> = {
  fast: {
    general: "ollama-cloud/deepseek-v4-flash",
    coder: "ollama-cloud/qwen3-coder-next",
  },
  balanced: {
    general: "ollama-cloud/glm-4.7",
    coder: "ollama-cloud/qwen3-coder:480b",
    vision: "ollama-cloud/qwen3-vl:235b",
  },
  reasoning: {
    general: "ollama-cloud/deepseek-v4-pro",
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

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
  Partial<Record<ModelTaskType, OllamaCloudModelRef>> & {
    general: OllamaCloudModelRef;
    vision: OllamaCloudModelRef;
  }
> = {
  fast: {
    general: "ollama-cloud/deepseek-v4-flash",
    coder: "ollama-cloud/qwen3-coder-next",
    // Smallest practical vision model: 8B, vision+tools, 256K context.
    vision: "ollama-cloud/ministral-3:8b",
  },
  balanced: {
    general: "ollama-cloud/glm-4.7",
    coder: "ollama-cloud/qwen3-coder:480b",
    vision: "ollama-cloud/qwen3-vl:235b",
  },
  reasoning: {
    general: "ollama-cloud/deepseek-v4-pro",
    // Largest non-preview reasoning+vision+tools model (262K context).
    // gemini-3-flash-preview was the previous pick (1M context) but is blocked
    // by the tools-blocklist as of pinchy#344 (silent hang + schema rejection on
    // the tools+vision path). Kimi family also avoided: v0.5.3 silent-500 incident.
    // Restore gemini-3-flash-preview here once upstream openclaw#72879 ships and
    // the silent-hang variant is fixed (track in pinchy#344).
    vision: "ollama-cloud/qwen3.5:397b",
  },
};

export function resolveOllamaCloud(hint: ModelHint): ResolverResult {
  const tierMap = BY_TIER_FAMILY[hint.tier];

  if (hint.capabilities?.includes("vision")) {
    const model = tierMap.vision;
    return {
      model,
      reason: `ollama-cloud: tier=${hint.tier}, capabilities=vision → ${model}`,
      fallbackUsed: false,
    };
  }

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

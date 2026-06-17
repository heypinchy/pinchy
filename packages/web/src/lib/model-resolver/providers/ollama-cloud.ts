import type { ModelHint, ModelTaskType, ModelTier, ResolverResult } from "../types";
import type { OllamaCloudModelId } from "@/lib/ollama-cloud-models";

// `OllamaCloudModelId` is a literal-string union derived from the curated
// list in `ollama-cloud-models.ts`. By typing each entry as
// `ollama-cloud/${OllamaCloudModelId}`, any stale or removed model ID
// becomes a TypeScript compile error — the v0.5.0 staging bug
// (`llama3.3:70b → HTTP 404`) would have failed `tsc` here.
type OllamaCloudModelRef = `ollama-cloud/${OllamaCloudModelId}`;

// NOTE: this resolver hardcodes its picks and does NOT filter through
// `isBlocked` at runtime (unlike `ollama-local.ts`, which does). The
// drift-guard test in `__tests__/ollama-cloud.test.ts` ("does NOT return
// a blocked model for any tier's vision slot") is what enforces the
// invariant — if you add or change an entry below that lands in the
// tools-blocklist, that test will fail before the regression ships.
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
    // qwen3-vl:235b(-instruct) was the pick but Ollama dropped both from the
    // cloud catalog (2026-06-17 discovery sweep). gemma4:31b is the balanced
    // vision replacement: vision+reasoning+tools, 262K context, already
    // empirically verified in ollama-cloud-models.ts.
    vision: "ollama-cloud/gemma4:31b",
  },
  reasoning: {
    general: "ollama-cloud/deepseek-v4-pro",
    // reasoning+vision+tools, 512K context. qwen3.5:397b was the previous pick
    // but only claims vision — the live endpoint hallucinates image contents
    // (see ollama-cloud-models.ts), so it is now flagged vision:false and can
    // no longer fill a vision slot. minimax-m3's vision was confirmed against
    // the live API (reads a random number + circle color correctly across
    // distinct images). gemini-3-flash-preview is still blocked by the
    // tools-blocklist (pinchy#344); kimi family avoided (v0.5.3 silent-500).
    vision: "ollama-cloud/minimax-m3",
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

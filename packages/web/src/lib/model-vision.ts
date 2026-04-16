import type { ProviderName } from "@/lib/providers";
import { VISION_OLLAMA_CLOUD_MODEL_IDS } from "@/lib/ollama-cloud-models";

// Providers where all current chat models support vision
export const VISION_CAPABLE_PROVIDERS: ProviderName[] = ["anthropic", "openai", "google"];

// Vision-capable LOCAL Ollama model prefixes. Kept as a prefix match because
// local users pull arbitrary tags (e.g. `llava:7b`, `llava:13b-q4_0`) and the
// prefix is the stable identifier. Cloud models go through
// VISION_OLLAMA_CLOUD_MODEL_IDS (exact-ID match against the curated list).
const VISION_OLLAMA_LOCAL_PREFIXES = [
  "llava",
  "llama3.2-vision",
  "bakllava",
  "qwen2-vl",
  "qwen2.5-vl",
  "qwen3-vl",
  "moondream",
  "minicpm-v",
  "gemma3",
  "gemma4",
];

// Dynamic vision capability cache — populated by provider-models.ts when fetching local Ollama models.
// null = not yet populated (use hardcoded fallback).
let ollamaLocalVisionCache: Set<string> | null = null;

export function setOllamaLocalVisionModels(models: Set<string> | null): void {
  ollamaLocalVisionCache = models;
}

export function isModelVisionCapable(modelId: string): boolean {
  const [provider, ...rest] = modelId.split("/");
  const modelName = rest.join("/");

  if (VISION_CAPABLE_PROVIDERS.includes(provider as ProviderName)) {
    return true;
  }

  if (provider === "ollama") {
    // If we have capability data from a recent fetch, use it
    if (ollamaLocalVisionCache !== null) {
      return ollamaLocalVisionCache.has(modelName);
    }
    // Fallback to hardcoded prefix list
    return VISION_OLLAMA_LOCAL_PREFIXES.some((prefix) => modelName.startsWith(prefix));
  }

  if (provider === "ollama-cloud") {
    // Exact match against the curated cloud allowlist — see
    // ollama-cloud-models.ts. We don't prefix-match here because cloud IDs
    // carry parameter tags (e.g. `qwen3.5:397b`) and the wrong prefix match
    // would mislabel `qwen3-coder-next` as vision-capable just because
    // `qwen3.5` is.
    return VISION_OLLAMA_CLOUD_MODEL_IDS.has(modelName);
  }

  return false;
}

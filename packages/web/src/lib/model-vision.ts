import type { ProviderName } from "@/lib/providers";

// Providers where all current chat models support vision
export const VISION_CAPABLE_PROVIDERS: ProviderName[] = ["anthropic", "openai", "google"];

// Known vision-capable Ollama model prefixes (local and cloud)
const VISION_OLLAMA_MODELS = [
  // Local models
  "llava",
  "llama3.2-vision",
  "bakllava",
  "qwen2-vl",
  "qwen2.5-vl",
  "moondream",
  "minicpm-v",
  // Cloud models (verified via ollama.com/search?c=vision&c=cloud)
  "gemini-3-flash-preview",
  "gemma3",
  "kimi-k2.5",
  "ministral-3",
  "mistral-large-3",
  "qwen3-vl",
  "qwen3.5",
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
    return VISION_OLLAMA_MODELS.some((prefix) => modelName.startsWith(prefix));
  }

  if (provider === "ollama-cloud") {
    return VISION_OLLAMA_MODELS.some((prefix) => modelName.startsWith(prefix));
  }

  return false;
}

import type { ProviderName } from "@/lib/providers";

// Providers where all current chat models support vision
export const VISION_CAPABLE_PROVIDERS: ProviderName[] = ["anthropic", "openai", "google"];

// Known vision-capable Ollama model prefixes
const VISION_OLLAMA_MODELS = [
  "llava",
  "llama3.2-vision",
  "bakllava",
  "qwen2-vl",
  "qwen2.5-vl",
  "moondream",
  "minicpm-v",
];

export function isModelVisionCapable(modelId: string): boolean {
  const [provider, ...rest] = modelId.split("/");
  const modelName = rest.join("/");

  if (VISION_CAPABLE_PROVIDERS.includes(provider as ProviderName)) {
    return true;
  }

  if (provider === "ollama") {
    return VISION_OLLAMA_MODELS.some((prefix) => modelName.startsWith(prefix));
  }

  return false;
}

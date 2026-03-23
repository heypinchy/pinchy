import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting } from "@/lib/settings";

// Re-export vision utilities for backwards compatibility
export { VISION_CAPABLE_PROVIDERS, isModelVisionCapable } from "@/lib/model-vision";

let cachedResult: ProviderModels[] | null = null;
let cachedAt: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function resetCache() {
  cachedResult = null;
  cachedAt = 0;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ProviderModels {
  id: ProviderName;
  name: string;
  models: ModelInfo[];
}

const FALLBACK_MODELS: Record<ProviderName, ModelInfo[]> = {
  anthropic: [
    { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "openai/gpt-4o", name: "GPT-4o" },
    { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "openai/o1", name: "o1" },
  ],
  google: [
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
};

interface ProviderFetchConfig {
  url: (apiKey: string) => string;
  headers: (apiKey: string) => Record<string, string>;
  transform: (data: Record<string, unknown>) => ModelInfo[];
}

const PROVIDER_FETCH_CONFIG: Record<ProviderName, ProviderFetchConfig> = {
  anthropic: {
    url: () => "https://api.anthropic.com/v1/models",
    headers: (apiKey) => ({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    transform: (data) =>
      (data.data as { id: string; display_name: string }[]).map((m) => ({
        id: `anthropic/${m.id}`,
        name: m.display_name,
      })),
  },
  openai: {
    url: () => "https://api.openai.com/v1/models",
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    transform: (data) =>
      (data.data as { id: string }[])
        .filter(
          (m) => (m.id.startsWith("gpt-") && !m.id.endsWith("-instruct")) || /^o\d/.test(m.id)
        )
        .map((m) => ({
          id: `openai/${m.id}`,
          name: m.id,
        })),
  },
  google: {
    url: (apiKey) => `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
    headers: () => ({}),
    transform: (data) =>
      (data.models as { name: string; displayName: string; supportedGenerationMethods: string[] }[])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => ({
          id: `google/${m.name.replace("models/", "")}`,
          name: m.displayName,
        })),
  },
};

async function fetchModelsForProvider(
  provider: ProviderName,
  apiKey: string
): Promise<ModelInfo[]> {
  const config = PROVIDER_FETCH_CONFIG[provider];
  const response = await fetch(config.url(apiKey), {
    headers: config.headers(apiKey),
  });

  if (!response.ok) {
    return FALLBACK_MODELS[provider];
  }

  const data = await response.json();
  return config.transform(data);
}

const DEFAULT_MODEL_PATTERNS: Record<ProviderName, RegExp> = {
  anthropic: /haiku/,
  openai: /gpt-.*-mini/,
  google: /gemini-.*-flash/,
};

const PREVIEW_PATTERN = /preview/i;

export function selectDefaultModel(provider: ProviderName, models: ModelInfo[]): string {
  const pattern = DEFAULT_MODEL_PATTERNS[provider];
  const candidates = models.filter((m) => pattern.test(m.id) && !PREVIEW_PATTERN.test(m.id));

  if (candidates.length > 0) {
    return candidates[candidates.length - 1].id;
  }

  return PROVIDERS[provider].defaultModel;
}

export async function getDefaultModel(provider: ProviderName): Promise<string> {
  const allProviders = await fetchProviderModels();
  const providerModels = allProviders.find((p) => p.id === provider);

  if (!providerModels || providerModels.models.length === 0) {
    return PROVIDERS[provider].defaultModel;
  }

  return selectDefaultModel(provider, providerModels.models);
}

export async function fetchProviderModels(): Promise<ProviderModels[]> {
  const now = Date.now();
  if (cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  const results: ProviderModels[] = [];

  for (const [providerName, providerConfig] of Object.entries(PROVIDERS)) {
    const provider = providerName as ProviderName;
    const apiKey = await getSetting(providerConfig.settingsKey);

    if (!apiKey) {
      continue;
    }

    try {
      const models = await fetchModelsForProvider(provider, apiKey);
      results.push({ id: provider, name: providerConfig.name, models });
    } catch {
      results.push({
        id: provider,
        name: providerConfig.name,
        models: FALLBACK_MODELS[provider],
      });
    }
  }

  cachedResult = results;
  cachedAt = now;
  return results;
}

import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting } from "@/lib/settings";

// Re-export vision utilities for backwards compatibility
export { VISION_CAPABLE_PROVIDERS, isModelVisionCapable } from "@/lib/model-vision";
import { setOllamaLocalVisionModels } from "@/lib/model-vision";

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

export interface OllamaModelCapabilities {
  vision: boolean;
  tools: boolean;
  completion: boolean;
  thinking: boolean;
}

export interface OllamaLocalModelInfo extends ModelInfo {
  parameterSize: string;
  capabilities: OllamaModelCapabilities;
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
  "ollama-cloud": [
    { id: "ollama-cloud/gemini-3-flash-preview:cloud", name: "Gemini 3 Flash Preview" },
    { id: "ollama-cloud/kimi-k2.5:cloud", name: "Kimi K2.5" },
    { id: "ollama-cloud/mistral-large-3:675b-cloud", name: "Mistral Large 3 675B" },
    { id: "ollama-cloud/qwen3.5:397b-cloud", name: "Qwen 3.5 397B" },
  ],
  "ollama-local": [],
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
  "ollama-cloud": {
    url: () => "https://ollama.com/v1/models",
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    transform: (data) => {
      // IDs as returned by the Ollama Cloud API (already include :cloud or -cloud suffix)
      const ALLOWED_CLOUD_MODELS = [
        "gemini-3-flash-preview:cloud",
        "kimi-k2.5:cloud",
        "mistral-large-3:675b-cloud",
        "qwen3.5:397b-cloud",
      ];
      return (data.data as { id: string }[])
        .filter((m) => ALLOWED_CLOUD_MODELS.includes(m.id))
        .map((m) => ({
          id: `ollama-cloud/${m.id}`,
          name: m.id.replace(/(-cloud|:cloud)$/, ""),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  },
  "ollama-local": {
    url: () => "",
    headers: () => ({}),
    transform: () => [],
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
  "ollama-cloud": /flash.*cloud/,
  "ollama-local": /.*/,
};

function parseParameterSize(size: string): number {
  const match = size.match(/^([\d.]+)([BMK]?)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || "").toUpperCase();
  if (unit === "B") return num * 1_000_000_000;
  if (unit === "M") return num * 1_000_000;
  if (unit === "K") return num * 1_000;
  return num;
}

export function selectOllamaLocalDefault(models: OllamaLocalModelInfo[]): string {
  if (models.length === 0) return "";

  // Prefer models with tool support, sorted by parameter size descending
  const withTools = models
    .filter((m) => m.capabilities.tools)
    .sort((a, b) => parseParameterSize(b.parameterSize) - parseParameterSize(a.parameterSize));

  if (withTools.length > 0) return withTools[0].id;

  // Fallback: largest completion model
  const sorted = [...models].sort(
    (a, b) => parseParameterSize(b.parameterSize) - parseParameterSize(a.parameterSize)
  );
  return sorted[0].id;
}

let lastOllamaLocalModels: OllamaLocalModelInfo[] = [];

export function getOllamaLocalModels(): OllamaLocalModelInfo[] {
  return lastOllamaLocalModels;
}

async function fetchOllamaLocalModels(baseUrl: string): Promise<OllamaLocalModelInfo[]> {
  const url = baseUrl.replace(/\/$/, "");
  const tagsResponse = await fetch(`${url}/api/tags`);
  if (!tagsResponse.ok) return [];

  const tagsData = await tagsResponse.json();
  const rawModels = tagsData.models as { name: string; details?: { parameter_size?: string } }[];

  const models: OllamaLocalModelInfo[] = [];
  for (const model of rawModels) {
    const showResponse = await fetch(`${url}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model.name }),
    });

    if (!showResponse.ok) continue;

    const showData = await showResponse.json();
    const capabilities: string[] = showData.capabilities || [];

    // Skip embedding-only models (no "completion" capability)
    if (!capabilities.includes("completion")) continue;

    const paramSize = showData.details?.parameter_size || model.details?.parameter_size || "";
    const displayName = paramSize ? `${model.name} (${paramSize})` : model.name;

    models.push({
      id: `ollama/${model.name}`,
      name: displayName,
      parameterSize: paramSize,
      capabilities: {
        vision: capabilities.includes("vision"),
        tools: capabilities.includes("tools"),
        completion: capabilities.includes("completion"),
        thinking: capabilities.includes("thinking"),
      },
    });
  }

  return models;
}

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

    if (provider === "ollama-local") continue;

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

  const ollamaUrl = await getSetting(PROVIDERS["ollama-local"].settingsKey);
  if (ollamaUrl) {
    try {
      const ollamaModels = await fetchOllamaLocalModels(ollamaUrl);
      lastOllamaLocalModels = ollamaModels;

      const visionModels = new Set(
        ollamaModels.filter((m) => m.capabilities.vision).map((m) => m.id.replace("ollama/", ""))
      );
      setOllamaLocalVisionModels(visionModels);

      results.push({
        id: "ollama-local" as ProviderName,
        name: PROVIDERS["ollama-local"].name,
        models: ollamaModels,
      });
    } catch {
      results.push({
        id: "ollama-local" as ProviderName,
        name: PROVIDERS["ollama-local"].name,
        models: [],
      });
    }
  }

  cachedResult = results;
  cachedAt = now;
  return results;
}

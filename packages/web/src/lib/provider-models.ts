import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting } from "@/lib/settings";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS } from "@/lib/ollama-cloud-models";

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
  compatible?: boolean;
  incompatibleReason?: string;
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
  "ollama-cloud": TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS.map((id) => ({
    id: `ollama-cloud/${id}`,
    name: id,
  })),
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
      // Filter by the curated tool-capable set — see
      // @/lib/ollama-cloud-models.ts for the source list. The /v1/models
      // endpoint doesn't expose capability metadata, so we can't infer
      // tool-capability live; every new model has to be opted in there.
      const allowed = new Set<string>(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS);
      return (data.data as { id: string }[])
        .filter((m) => allowed.has(m.id))
        .map((m) => ({
          id: `ollama-cloud/${m.id}`,
          name: m.id,
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
  "ollama-cloud": /flash/,
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

const PREFERRED_MODEL_FAMILIES = [/^qwen/i];

export function selectOllamaLocalDefault(models: OllamaLocalModelInfo[]): string {
  if (models.length === 0) return "";

  const withTools = models.filter((m) => m.capabilities.tools);

  if (withTools.length > 0) {
    // Prefer models from known-good families (qwen has best tool-calling reliability)
    for (const pattern of PREFERRED_MODEL_FAMILIES) {
      const preferred = withTools
        .filter((m) => pattern.test(m.id.replace("ollama/", "")))
        .sort((a, b) => parseParameterSize(b.parameterSize) - parseParameterSize(a.parameterSize));
      if (preferred.length > 0) return preferred[0].id;
    }

    // Fallback: largest tool-capable model
    const sorted = [...withTools].sort(
      (a, b) => parseParameterSize(b.parameterSize) - parseParameterSize(a.parameterSize)
    );
    return sorted[0].id;
  }

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

// Per-call timeout for Ollama discovery requests. Each `/api/show` call
// runs sequentially today, so a hanging Ollama instance with many installed
// models could otherwise wedge the setup wizard for minutes. Five seconds
// per call is plenty for a healthy local Ollama on the same host.
const OLLAMA_FETCH_TIMEOUT_MS = 5_000;

function ollamaFetchSignal(): AbortSignal {
  // AbortSignal.timeout exists in Node 20+, which Pinchy already requires.
  return AbortSignal.timeout(OLLAMA_FETCH_TIMEOUT_MS);
}

export async function fetchOllamaLocalModelsFromUrl(
  baseUrl: string
): Promise<OllamaLocalModelInfo[]> {
  const url = baseUrl.replace(/\/$/, "");
  let tagsResponse: Response;
  try {
    tagsResponse = await fetch(`${url}/api/tags`, { signal: ollamaFetchSignal() });
  } catch {
    return [];
  }
  if (!tagsResponse.ok) return [];

  const tagsData = await tagsResponse.json();
  const rawModels = tagsData.models as { name: string; details?: { parameter_size?: string } }[];

  const models: OllamaLocalModelInfo[] = [];
  for (const model of rawModels) {
    let showResponse: Response;
    try {
      showResponse = await fetch(`${url}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model.name }),
        signal: ollamaFetchSignal(),
      });
    } catch {
      // Per-model timeout — skip this model and keep going so a single
      // hanging model can't poison the whole list.
      continue;
    }

    if (!showResponse.ok) continue;

    const showData = await showResponse.json();
    const capabilities: string[] = showData.capabilities || [];

    // Skip embedding-only models (no "completion" capability)
    if (!capabilities.includes("completion")) continue;

    const paramSize = showData.details?.parameter_size || model.details?.parameter_size || "";
    const displayName = paramSize ? `${model.name} (${paramSize})` : model.name;
    const hasTools = capabilities.includes("tools");

    models.push({
      id: `ollama/${model.name}`,
      name: displayName,
      parameterSize: paramSize,
      compatible: hasTools,
      incompatibleReason: hasTools ? undefined : "Not compatible — does not support agent tools",
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

/** Extract the YYYYMMDD date suffix from a model ID, or 0 if none found. */
function extractModelDate(modelId: string): number {
  const match = /(\d{8})$/.exec(modelId);
  return match ? parseInt(match[1], 10) : 0;
}

export function selectDefaultModel(provider: ProviderName, models: ModelInfo[]): string {
  const pattern = DEFAULT_MODEL_PATTERNS[provider];
  const candidates = models.filter((m) => pattern.test(m.id) && !PREVIEW_PATTERN.test(m.id));

  if (candidates.length > 0) {
    // Pick the most recent model by date suffix (YYYYMMDD)
    candidates.sort((a, b) => extractModelDate(b.id) - extractModelDate(a.id));
    return candidates[0].id;
  }

  return PROVIDERS[provider].defaultModel;
}

export async function getDefaultModel(provider: ProviderName): Promise<string> {
  const allProviders = await fetchProviderModels();
  const providerModels = allProviders.find((p) => p.id === provider);

  if (!providerModels || providerModels.models.length === 0) {
    return PROVIDERS[provider].defaultModel;
  }

  // Local Ollama uses capability-based heuristic (largest model with tool support)
  if (provider === "ollama-local") {
    return selectOllamaLocalDefault(lastOllamaLocalModels) || PROVIDERS[provider].defaultModel;
  }

  return selectDefaultModel(provider, providerModels.models);
}

export async function fetchProviderModels(): Promise<ProviderModels[]> {
  // Cache only cloud providers (their model lists rarely change).
  // Ollama local is always fetched live — users expect newly pulled models immediately.
  const now = Date.now();
  let cloudResults: ProviderModels[];

  if (cachedResult && now - cachedAt < CACHE_TTL_MS) {
    cloudResults = cachedResult;
  } else {
    cloudResults = [];

    for (const [providerName, providerConfig] of Object.entries(PROVIDERS)) {
      const provider = providerName as ProviderName;

      if (provider === "ollama-local") continue;

      const apiKey = await getSetting(providerConfig.settingsKey);

      if (!apiKey) {
        continue;
      }

      try {
        const models = await fetchModelsForProvider(provider, apiKey);
        cloudResults.push({ id: provider, name: providerConfig.name, models });
      } catch {
        cloudResults.push({
          id: provider,
          name: providerConfig.name,
          models: FALLBACK_MODELS[provider],
        });
      }
    }

    cachedResult = cloudResults;
    cachedAt = now;
  }

  const results = [...cloudResults];

  const ollamaUrl = await getSetting(PROVIDERS["ollama-local"].settingsKey);
  if (ollamaUrl) {
    try {
      const ollamaModels = await fetchOllamaLocalModelsFromUrl(ollamaUrl);
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

  return results;
}

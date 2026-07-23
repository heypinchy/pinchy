import { DEFAULT_MODEL_CAPS, lookupModelCapabilities } from "@/lib/model-catalog";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";
import { PROVIDER_PROBE_TIMEOUT_MS, type ValidationResult } from "@/lib/providers";

// Generic "OpenAI-compatible" provider (#894). Any endpoint exposing the
// OpenAI REST surface — `GET /models` for discovery, Bearer auth — can be
// wired in without a bespoke ProviderName case. Discovery and validation both
// hit the same `/models` endpoint the OpenAI probe uses in providers.ts, and
// reuse that module's timeout + single-retry-on-auth-failure conventions.

/**
 * Join a provider base URL with `/models`, tolerating a single trailing slash
 * so `https://host/v1/` does not become `https://host/v1//models`.
 */
function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/models`;
}

function fetchModels(baseUrl: string, apiKey: string): Promise<Response> {
  return fetch(modelsUrl(baseUrl), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
  });
}

/**
 * Probe an OpenAI-compatible endpoint's `GET /models` to validate credentials.
 * Mirrors validateProviderKey in providers.ts: 200 ⇒ valid, 401/403 retried
 * once before declaring the key invalid, any other non-2xx ⇒ provider_error,
 * and a throw/abort ⇒ network_error. Never surfaces the API key in an error.
 */
export async function validateOpenAiCompatibleProvider(
  baseUrl: string,
  apiKey: string
): Promise<ValidationResult> {
  try {
    const response = await fetchModels(baseUrl, apiKey);

    if (response.ok) return { valid: true };

    // 401/403 could be a genuinely invalid key, or a transient auth issue.
    // Retry once before declaring invalid (mirrors validateProviderKey).
    if (response.status === 401 || response.status === 403) {
      await new Promise((r) => setTimeout(r, 1000));
      const retry = await fetchModels(baseUrl, apiKey);
      if (retry.ok) return { valid: true };
      return { valid: false, error: "invalid_key" };
    }

    // Anything else (429, 5xx, etc.) = provider issue, not necessarily a bad key.
    return { valid: false, error: "provider_error", status: response.status };
  } catch {
    return { valid: false, error: "network_error" };
  }
}

/**
 * Discover an OpenAI-compatible endpoint's model list via `GET /models`.
 * Each returned id is resolved to full capabilities from the model catalog,
 * falling back to the compaction-safe DEFAULT_MODEL_CAPS for unknown ids.
 * Returns [] on any non-200, throw, or malformed body — the caller then falls
 * back to manual model-id entry. Defensive against missing/empty `data`,
 * non-array `data`, and entries without a usable string `id`.
 */
export async function fetchOpenAiCompatibleModels(
  baseUrl: string,
  apiKey: string
): Promise<OpenClawModelDefinition[]> {
  try {
    const response = await fetchModels(baseUrl, apiKey);
    if (!response.ok) return [];

    const body: unknown = await response.json();
    const data =
      typeof body === "object" && body !== null && "data" in body
        ? (body as { data: unknown }).data
        : undefined;
    if (!Array.isArray(data)) return [];

    const models: OpenClawModelDefinition[] = [];
    for (const entry of data) {
      const id =
        typeof entry === "object" && entry !== null && "id" in entry
          ? (entry as { id: unknown }).id
          : undefined;
      if (typeof id !== "string" || id.length === 0) continue;
      models.push(lookupModelCapabilities(id) ?? { ...DEFAULT_MODEL_CAPS, id, name: id });
    }
    return models;
  } catch {
    return [];
  }
}

import { DEFAULT_MODEL_CAPS, lookupModelCapabilities } from "@/lib/model-catalog";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";
import {
  AUTH_RETRY_DELAY_MS,
  PROVIDER_PROBE_TIMEOUT_MS,
  type ValidationResult,
} from "@/lib/providers";

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

/** Safely read a property off an unknown value without throwing on non-objects. */
function readProp(x: unknown, key: string): unknown {
  return typeof x === "object" && x !== null && key in x
    ? (x as Record<string, unknown>)[key]
    : undefined;
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
    // Deliberately mirrors validateProviderKey's retry shape in providers.ts:
    // a single retry on 401/403, same shared delay, before declaring invalid.
    if (response.status === 401 || response.status === 403) {
      await new Promise((r) => setTimeout(r, AUTH_RETRY_DELAY_MS));
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

// Ids that are clearly not chat/completions models. A `/models` listing on a
// real gateway (Together, Groq, a private LiteLLM/vLLM proxy, …) commonly
// mixes embedding, reranking, TTS, transcription, and moderation models in
// with the chat models — none of which OpenClaw can use as an agent's
// primary/fallback model, and offering them in the picker would just be
// confusing (or actively break a chat request that tries to use one).
// Conservative and case-insensitive: only ids that plainly signal one of
// these categories are dropped.
const NON_CHAT_MODEL_PATTERN =
  /(embed|embedding|rerank|reranker|tts|text-to-speech|whisper|moderation|guard)/i;

/**
 * Discover an OpenAI-compatible endpoint's model list via `GET /models`.
 * Each returned id is resolved to full capabilities from the model catalog,
 * falling back to the compaction-safe DEFAULT_MODEL_CAPS for unknown ids.
 * Returns [] on any non-200, throw, or malformed body — the caller then falls
 * back to manual model-id entry. Defensive against missing/empty `data`,
 * non-array `data`, and entries without a usable string `id`. Ids matching
 * {@link NON_CHAT_MODEL_PATTERN} (embeddings, rerankers, TTS, whisper,
 * moderation, guard models) are filtered out — see its doc-comment.
 */
export async function fetchOpenAiCompatibleModels(
  baseUrl: string,
  apiKey: string
): Promise<OpenClawModelDefinition[]> {
  try {
    const response = await fetchModels(baseUrl, apiKey);
    if (!response.ok) return [];

    const body: unknown = await response.json();
    const data = readProp(body, "data");
    if (!Array.isArray(data)) return [];

    const models: OpenClawModelDefinition[] = [];
    for (const entry of data) {
      const id = readProp(entry, "id");
      if (typeof id !== "string" || id.length === 0) continue;
      if (NON_CHAT_MODEL_PATTERN.test(id)) continue;
      models.push(lookupModelCapabilities(id) ?? { ...DEFAULT_MODEL_CAPS, id, name: id });
    }
    return models;
  } catch {
    return [];
  }
}

// Live-read cache for custom OpenAI-compatible providers (#894 backend
// redesign). Mirrors the ollama-local pattern in provider-models.ts
// (`ollamaLocalCache` / `OLLAMA_LOCAL_CACHE_TTL_MS`): the model list feeds
// BOTH the agent model dropdown and openclaw.json emission, both of which run
// far more often than a provider's catalog actually changes, so a short-lived
// in-memory cache absorbs repeated calls (every `regenerateOpenClawConfig()`,
// every dashboard model-list fetch) without re-hitting the endpoint each
// time. An hour is generous compared to ollama-local's 10s: a custom endpoint
// is a remote HTTP call (real network latency, real cost to hammer), and —
// unlike ollama-local — there is no "I just pulled a new model, show it now"
// UX expectation driving a short TTL here.
const CUSTOM_PROVIDER_MODEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const customProviderModelCache = new Map<
  string,
  { fetchedAt: number; result: OpenClawModelDefinition[] }
>();

/** Clear the custom-provider live-model cache (mirrors provider-models.ts's `resetCache()`). */
export function resetCustomModelCache(): void {
  customProviderModelCache.clear();
}

/** The inputs `resolveCustomProviderModels` needs to resolve one provider's live model list. */
export interface CustomProviderModelSource {
  /** Cache key. Stable per row (immutable once created). */
  slug: string;
  baseUrl: string;
  /** Decrypted API key. */
  apiKey: string;
  /** Last-known-good snapshot, written at save time — the offline/failure fallback. */
  models: OpenClawModelDefinition[];
}

/**
 * Resolve a custom OpenAI-compatible provider's model list: live, with a
 * short-TTL cache and an offline fallback to the last-known-good snapshot
 * (`p.models`, written at save time — see the `models` column doc-comment in
 * db/schema.ts). Mirrors `fetchOllamaLocalModelsFromUrl`'s cache+fallback
 * shape in provider-models.ts.
 *
 * - Cache hit (within {@link CUSTOM_PROVIDER_MODEL_CACHE_TTL_MS} of the last
 *   successful live fetch) ⇒ return the cached result, no network call.
 * - Cache miss ⇒ call `fetchOpenAiCompatibleModels(baseUrl, apiKey)`.
 *   - ≥1 model discovered ⇒ cache it and return it.
 *   - 0 models, or the call throws ⇒ return the snapshot WITHOUT caching, so
 *     the very next call retries live rather than pinning the fallback for a
 *     full TTL window (an endpoint that's down for one call may be back up
 *     for the next).
 */
export async function resolveCustomProviderModels(
  p: CustomProviderModelSource
): Promise<OpenClawModelDefinition[]> {
  const cached = customProviderModelCache.get(p.slug);
  if (cached && Date.now() - cached.fetchedAt < CUSTOM_PROVIDER_MODEL_CACHE_TTL_MS) {
    return cached.result;
  }

  let live: OpenClawModelDefinition[];
  try {
    live = await fetchOpenAiCompatibleModels(p.baseUrl, p.apiKey);
  } catch {
    return p.models;
  }

  if (live.length === 0) {
    return p.models;
  }

  customProviderModelCache.set(p.slug, { fetchedAt: Date.now(), result: live });
  return live;
}

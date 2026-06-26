import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting } from "@/lib/settings";
import { getDefaultModel, fetchProviderModels } from "@/lib/provider-models";
import { isModelVisionCapable } from "@/lib/model-vision";
import { ensureModelCapabilityCacheLoaded } from "@/lib/model-capabilities/cache";
import {
  TOOL_CAPABLE_OLLAMA_CLOUD_MODELS,
  type OllamaCloudModelId,
} from "@/lib/ollama-cloud-models";

/**
 * Vision-model selection for OpenClaw's built-in `pdf` and `image` tools.
 *
 * Extracted from build.ts: these resolvers are a self-contained concern —
 * given the configured providers, pick the model that the pdf/image tool
 * should route to. `regenerateOpenClawConfig` consumes the two async
 * resolvers; everything else here is module-internal preference data.
 */

/**
 * Resolve a vision-capable model to use for the built-in `pdf` tool.
 *
 * Preference is EXPLICIT (not derived from `Object.entries(PROVIDERS)` order)
 * so adding a new provider can't silently shift PDF-model selection. Two
 * tiers, ordered:
 *   1. Native PDF providers — raw bytes to model, highest fidelity.
 *   2. Vision fallback — image-extract pipeline; lower fidelity but works
 *      when no native provider is configured.
 *
 * Within each tier, list order is the preference order. Returns null when
 * none of the listed providers is configured (text-only stack).
 *
 * `ollama-local` is intentionally absent: vision capability depends on
 * which model the user has pulled, and `getDefaultModel("ollama-local")`
 * returns `ollama/llama3.2` which is text-only. A future change could
 * call `isModelVisionCapable` against the configured default here.
 */
const PDF_MODEL_PREFERENCE: readonly ProviderName[] = [
  "anthropic", // native PDF
  "google", // native PDF
  "openai", // vision fallback
  "ollama-cloud", // vision fallback
];

export async function resolveDefaultPdfModel(): Promise<string | null> {
  // Guard against a regenerate call landing before bootInits has loaded the
  // cache. `isModelVisionCapable` is sync and would otherwise return false
  // for every model, silently picking the last (untyped) provider in the
  // preference order.
  await ensureModelCapabilityCacheLoaded();
  for (const provider of PDF_MODEL_PREFERENCE) {
    // `provider` is a typed ProviderName from the const tuple above, never
    // user input — `PROVIDERS[provider]` is safe key access on a finite map.
    // eslint-disable-next-line security/detect-object-injection
    const key = await getSetting(PROVIDERS[provider].settingsKey);
    if (!key) continue;
    const model = await getDefaultModel(provider);
    if (!model) continue;
    // Native PDF providers (anthropic, google) are always vision-capable,
    // so the check is a no-op there. For the fallback tier the check
    // guards against a provider whose default model isn't actually
    // vision-capable (e.g. a future text-only model winning the slot).
    if (isModelVisionCapable(model)) return model;
  }
  return null;
}

/**
 * Resolve a vision-capable model to use for the built-in `image` tool.
 *
 * Same provider order as PDF: native vision (anthropic, google) > vision
 * fallback (openai, ollama-cloud). Without this field, OpenClaw scans
 * providers in their declared order and picks the first vision-flagged
 * model — which on an ollama-cloud-only stack used to land on
 * `devstral-small-2:24b` alphabetically, even though the live API rejects
 * images for that model with HTTP 400 (#416). Pinning the choice removes
 * that fragility.
 *
 * For `ollama-cloud`, empirical API probing showed the vision-flagged line
 * is uneven: some models (`mistral-large-3:675b`, `kimi-k2.5`/`k2.6`) accept
 * image input but occasionally misread digits, and `qwen3.5:397b` only
 * claims vision — it hallucinates image contents and is now flagged
 * vision:false (see ollama-cloud-models.ts). We pin the choice to the
 * best empirically vision-verified models (`gemini-3-flash-preview` >
 * `minimax-m3` > `gemma4:31b`; qwen3-vl led this list until Ollama dropped it
 * from the cloud catalog) via the typed `OLLAMA_CLOUD_IMAGE_PREFERENCE` list.
 * The TypeScript
 * constraint on that list (must be `OllamaCloudModelId`) means an unknown
 * ID fails to compile, so a runtime fallback to
 * `getDefaultModel("ollama-cloud")` would only fire if every preference
 * entry were removed from the curated
 * list — at which point the right action is to update the preference list,
 * not silently route to the provider's balanced text-only default. So we
 * skip the provider in that case and continue down the preference order.
 */
const IMAGE_MODEL_PREFERENCE: readonly ProviderName[] = [
  "anthropic", // native vision
  "google", // native vision
  "openai", // native vision
  "ollama-cloud", // vision fallback
];

// Best-vision ollama-cloud picks, in preference order. Subset of
// TOOL_CAPABLE_OLLAMA_CLOUD_MODELS — TypeScript rejects unknown IDs.
// Exported for the drift-guard test in
// `__tests__/lib/ollama-cloud-image-preference-drift.test.ts`, which
// asserts every entry here is still flagged `vision: true` in the curated
// catalog. That keeps the preference list and the vision flags from
// silently de-syncing (e.g. if a future catalog update demotes one of
// these models the way #416 demoted devstral).
export const OLLAMA_CLOUD_IMAGE_PREFERENCE: readonly OllamaCloudModelId[] = [
  // qwen3-vl:235b(-instruct) led this list but Ollama dropped both from the
  // cloud catalog (2026-06-17 discovery sweep). The remaining picks are all
  // empirically vision-verified: gemini-3-flash-preview (1M context; blocked
  // only for *tool* slots, fine for pure image description) and minimax-m3
  // (reads numbers + circle colors correctly across distinct images) lead,
  // with gemma4:31b behind them.
  "gemini-3-flash-preview",
  "minimax-m3",
  "gemma4:31b",
];

/**
 * Bare ollama-cloud model ids that are currently LIVE — i.e. present in the
 * provider's `/v1/models` catalog right now.
 *
 * `fetchProviderModels` already intersects the live `/v1/models` response with
 * the curated tool-capable set and, on a fetch failure, falls back to the full
 * curated list (`FALLBACK_MODELS`). So this is "live ∩ curated, degrading to
 * curated when offline" — exactly the availability signal we want, without a
 * second network call. We strip the `ollama-cloud/` prefix to compare against
 * the bare catalog ids in `OLLAMA_CLOUD_IMAGE_PREFERENCE`.
 */
async function fetchLiveOllamaCloudModelIds(): Promise<Set<string>> {
  const providers = await fetchProviderModels();
  const oc = providers.find((p) => p.id === "ollama-cloud");
  if (!oc) return new Set();
  return new Set(oc.models.map((m) => m.id.replace(/^ollama-cloud\//, "")));
}

/**
 * Pick the best vision-verified ollama-cloud image model that is BOTH curated
 * (empirically vision-capable) AND currently live in the catalog.
 *
 * The live-availability gate is the fix for the v0.5.8 incident: the resolver
 * used to pick a model purely from the static curated list, so when Ollama
 * retired `qwen3-vl:235b-instruct` upstream (HTTP 410) the dead model stayed
 * pinned in `openclaw.json` until the next Pinchy upgrade. Intersecting with
 * the live `/v1/models` catalog means a retired model is skipped immediately —
 * the resolver falls through to the next live preference (`minimax-m3` …).
 */
async function pickOllamaCloudImageModel(): Promise<string | null> {
  const liveIds = await fetchLiveOllamaCloudModelIds();
  for (const id of OLLAMA_CLOUD_IMAGE_PREFERENCE) {
    const curated = TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.some((m) => m.id === id);
    if (curated && liveIds.has(id)) {
      return `ollama-cloud/${id}`;
    }
  }
  return null;
}

export async function resolveDefaultImageModel(): Promise<string | null> {
  for (const provider of IMAGE_MODEL_PREFERENCE) {
    // eslint-disable-next-line security/detect-object-injection
    const key = await getSetting(PROVIDERS[provider].settingsKey);
    if (!key) continue;
    if (provider === "ollama-cloud") {
      const picked = await pickOllamaCloudImageModel();
      if (picked) return picked;
      continue;
    }
    const model = await getDefaultModel(provider);
    if (!model) continue;
    if (isModelVisionCapable(model)) return model;
  }
  return null;
}

function providerImageRank(provider: string): number {
  const idx = IMAGE_MODEL_PREFERENCE.indexOf(provider as ProviderName);
  return idx >= 0 ? idx : IMAGE_MODEL_PREFERENCE.length;
}

// Rank a model WITHIN its provider. Only ollama-cloud carries a curated
// quality order (`OLLAMA_CLOUD_IMAGE_PREFERENCE`); every other provider returns
// a constant, so its models fall through to the comparator's alphabetical
// tiebreak. Uncurated ollama-cloud vision models sort after the curated ones.
function intraProviderVisionRank(provider: string, modelId: string): number {
  if (provider !== "ollama-cloud") return 0;
  const idx = OLLAMA_CLOUD_IMAGE_PREFERENCE.indexOf(modelId as OllamaCloudModelId);
  return idx >= 0 ? idx : OLLAMA_CLOUD_IMAGE_PREFERENCE.length;
}

/**
 * Comparator (best first) for ordering vision-capable models as per-turn image
 * fallbacks. Mirrors the preference ORDER of `resolveDefaultImageModel` so the
 * fallback lands on the same quality ranking rather than a non-deterministic DB
 * row order:
 *
 *   1. Native-vision providers first, in `IMAGE_MODEL_PREFERENCE` order.
 *   2. Within ollama-cloud, the curated `OLLAMA_CLOUD_IMAGE_PREFERENCE` order
 *      (e.g. `minimax-m3` ahead of `gemma4:31b`), with uncurated vision models
 *      ranked after the curated ones.
 *   3. Ties broken alphabetically by `provider/modelId` for determinism.
 *
 * It mirrors only the ORDER, not `resolveDefaultImageModel`'s live-catalog
 * gating (`fetchLiveOllamaCloudModelIds`): the candidates fed to this comparator
 * already come from the `models` table, so they exist by construction — there is
 * nothing to gate. This also only orders by quality; the tools blocklist (which
 * keeps a tool agent off `gemini-3-flash-preview` even though it tops the
 * curated list) is applied separately by `resolveVisionFallbackModel`.
 */
export function compareVisionFallbackPreference(
  a: { provider: string; modelId: string },
  b: { provider: string; modelId: string }
): number {
  const pa = providerImageRank(a.provider);
  const pb = providerImageRank(b.provider);
  if (pa !== pb) return pa - pb;

  const ma = intraProviderVisionRank(a.provider, a.modelId);
  const mb = intraProviderVisionRank(b.provider, b.modelId);
  if (ma !== mb) return ma - mb;

  return `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`);
}

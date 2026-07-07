import type { ProviderName } from "@/lib/providers";

/**
 * OpenClaw ModelDefinitionConfig shape — used in models.providers.<name>.models[]
 * when Pinchy emits an explicit provider block instead of relying on OpenClaw's
 * env-var auto-discovery.
 *
 * IDs must NOT carry the provider prefix: OpenClaw derives the full qualified
 * ID from the provider key + the local ID here (e.g. "anthropic" + "claude-haiku-4-5-20251001"
 * → the agent's model field "anthropic/claude-haiku-4-5-20251001").
 */
export interface OpenClawModelDefinition {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  vision: boolean;
  input: string[];
  // cacheRead/cacheWrite are REQUIRED, not optional: OpenClaw's per-agent
  // model-catalog schema (openclaw-plugin-model-catalog-v1) rejects any model
  // whose cost omits them, then drops the ENTIRE provider from that agent's
  // effective catalog. That silently breaks every tool that resolves a model
  // from it — including the built-in `pdf`/vision tool, which defaults to
  // openai/gpt-5.5 (staging symptom: `pdf failed: Unknown model: openai/gpt-5.5`,
  // so invoice PDFs were never read and the agent booked an unverified lump sum
  // while reporting success). Keeping the fields required makes an omission a
  // compile error here, not a runtime schema failure surfaced only when an
  // agent's per-agent catalog happens to be regenerated.
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

const ANTHROPIC_MODELS: OpenClawModelDefinition[] = [
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    contextWindow: 200000,
    maxTokens: 32000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextWindow: 200000,
    maxTokens: 16000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextWindow: 200000,
    maxTokens: 16000,
    reasoning: false,
    vision: true,
    input: ["text", "image"],
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
];

// cacheRead/cacheWrite are set to 0 here (not modeled), matching the ZERO_COST
// convention used for ollama-cloud in build.ts. Unlike Anthropic — which
// publishes distinct cache-tier rates we carry above — we do not freeze a
// synthetic OpenAI/Google cache discount, because a hardcoded price silently
// goes stale between releases. The schema only requires the fields to be
// present; accurate, refreshable provider pricing is tracked in #677.
const OPENAI_MODELS: OpenClawModelDefinition[] = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 128000,
    maxTokens: 32000,
    reasoning: false,
    vision: true,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: false,
    vision: true,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: false,
    vision: true,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
  },
];

const GOOGLE_MODELS: OpenClawModelDefinition[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: false,
    vision: true,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  },
];

const BUILTIN_MODEL_CATALOGS: Partial<Record<ProviderName, OpenClawModelDefinition[]>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  google: GOOGLE_MODELS,
};

/**
 * Returns the OpenClaw ModelDefinitionConfig list for a built-in provider.
 * Only covers providers that need explicit model declarations (anthropic,
 * openai, google). Returns an empty array for providers not in the catalog
 * (ollama-cloud, ollama-local — handled separately in build.ts).
 */
export function getModelCatalogForProvider(provider: ProviderName): OpenClawModelDefinition[] {
  return BUILTIN_MODEL_CATALOGS[provider] ?? [];
}

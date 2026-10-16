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

// This list is the whole of what Pinchy knows about a built-in provider's
// models: build.ts emits it to OpenClaw, and seedBuiltinModels turns it into the
// capability rows (vision/tools/long-context) every model decision reads. The
// agent model picker lists the provider's LIVE catalog instead, so a model the
// provider serves but this list omits is selectable yet half-supported — it
// reads as "not vision-capable" and drops out of the pdf/image chain.
//
// Newest first; the entries after the current generation stay because agents
// are pinned to them. Limits must agree with the vendored models.dev snapshot
// (guarded in openclaw-builtin-models.test.ts); `maxTokens` may sit below the
// model's own output cap, never above it.
//
// Anthropic prices: platform.claude.com/docs/en/about-claude/pricing, read
// 2026-10-16 — input / output / cache hits / 5-minute cache writes. Haiku 5.5
// is priced by prompt length; this is its tier for prompts up to 100K tokens
// ($0.50 / $2.50 / $0.05 / $0.625 above), the one a turn under Pinchy's 262K
// effective-context ceiling pays until the conversation grows past 100K.
//
// The 5.x models all think by default, and Opus 5.5, Sonnet 5.5, Fable 5.1
// reject `thinking: {type: "disabled"}`. Whether a request is shaped that way
// is OpenClaw's business, not this catalog's: an OpenClaw that predates these
// models treats Opus 5.5 and Haiku 5.5 as pre-adaptive Claude models.
const ANTHROPIC_MODELS: OpenClawModelDefinition[] = [
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    contextWindow: 1000000,
    maxTokens: 32000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextWindow: 1000000,
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
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
];

// cacheRead/cacheWrite are set to 0 here (not modeled), matching the ZERO_COST
// convention used for ollama-cloud in build.ts. Unlike Anthropic — which
// publishes distinct cache-tier rates we carry above — we do not freeze a
// synthetic OpenAI/Google cache discount, because a hardcoded price silently
// goes stale between releases. The schema only requires the fields to be
// present; accurate, refreshable provider pricing is tracked in #677.
//
// Input/output: developers.openai.com/api/docs/pricing, read 2026-10-16, the
// tier for prompts up to 272K tokens (the long-context tier starts above
// Pinchy's 262K effective-context ceiling). GPT-6 Sol's API id is
// `gpt-6.1-sol` — `gpt-6-sol` is the earlier release.
const OPENAI_MODELS: OpenClawModelDefinition[] = [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    contextWindow: 1050000,
    maxTokens: 128000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    contextWindow: 1050000,
    maxTokens: 128000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    contextWindow: 1050000,
    maxTokens: 128000,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 1050000,
    maxTokens: 32000,
    reasoning: false,
    vision: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 1050000,
    maxTokens: 16384,
    reasoning: false,
    vision: true,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    contextWindow: 400000,
    maxTokens: 16384,
    reasoning: false,
    vision: true,
    input: ["text", "image"],
    cost: { input: 0.75, output: 4.5, cacheRead: 0, cacheWrite: 0 },
  },
];

// Prices: ai.google.dev/gemini-api/docs/pricing, read 2026-10-16. Gemini 4
// Argon and Gemini 3.8 Flash launched at introductory prices (half the figures
// below, until 2026-11-30 and 2026-12-31 respectively); the catalog carries the
// price they settle at, since a release outlives both windows. The 2.5 models
// stay for agents already on them; Google now serves them only to accounts
// that used them before, which is why none of them is a default any more.
const GOOGLE_MODELS: OpenClawModelDefinition[] = [
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 4, output: 20, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    vision: true,
    input: ["text", "image"],
    cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 },
  },
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
    cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 },
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

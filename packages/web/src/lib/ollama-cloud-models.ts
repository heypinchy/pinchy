/**
 * The canonical list of tool-capable Ollama Cloud models Pinchy surfaces.
 *
 * Source of truth: each model's capability tags on its
 * ollama.com/library/<name> page. The aggregate pages
 * search?c=tools&c=cloud, search?c=vision&c=cloud, and search?c=thinking&c=cloud
 * are useful starting points but are incomplete — they omit several
 * genuinely tool/vision/thinking-capable cloud models that individual
 * library pages confirm — so always cross-check against the library page
 * before trusting the search listing.
 *
 * Context windows follow Ollama's "NK" = N * 1024 convention (verified by
 * cross-checking known models like "160K" → 163840). Pinchy writes these
 * hints into the OpenClaw config so context pruning can kick in before
 * requests bump into the real provider limit.
 *
 * Cost is always zero: Ollama Cloud uses subscription pricing (Free / Pro /
 * Max plans — see ollama.com/pricing), not per-token billing. A fabricated
 * per-token rate would make Pinchy's Usage & Costs dashboard lie about
 * spend, so we leave cost at zero and let the UI show tokens only.
 *
 * When Ollama adds, removes, or resizes a model, update this file — the
 * ALLOWED_CLOUD_MODELS filter, the fallback list for the model picker, the
 * vision check, and the OpenClaw config are all derived from it.
 */

export interface OllamaCloudModel {
  /** ID exactly as returned by https://ollama.com/v1/models (no ":cloud" suffix). */
  id: string;
  /** Native context window in tokens (from ollama.com/library/<name>). */
  contextWindow: number;
  /** Pinchy's max output tokens hint. Ollama doesn't publish this, so we use
   * the output-heavy value for Gemini Flash and a conservative 8192 elsewhere. */
  maxTokens: number;
  /** True when the library page carries the "thinking" capability tag. */
  reasoning: boolean;
  /** True when the library page lists "Image" in the input types (vision). */
  vision: boolean;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// `as const satisfies` keeps the literal types of every `id` (so we can
// derive a strict union below) while still validating each entry against
// the `OllamaCloudModel` shape.
export const TOOL_CAPABLE_OLLAMA_CLOUD_MODELS = [
  {
    id: "deepseek-v3.1:671b",
    contextWindow: 163840,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  { id: "deepseek-v3.2", contextWindow: 163840, maxTokens: 8192, reasoning: true, vision: false },
  {
    id: "deepseek-v4-flash",
    contextWindow: 1048576,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    id: "deepseek-v4-pro",
    contextWindow: 1048576,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    id: "devstral-2:123b",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: false,
    vision: false,
  },
  {
    id: "devstral-small-2:24b",
    contextWindow: 393216,
    maxTokens: 8192,
    reasoning: false,
    vision: true,
  },
  {
    id: "gemini-3-flash-preview",
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    vision: true,
  },
  { id: "gemma4:31b", contextWindow: 262144, maxTokens: 8192, reasoning: true, vision: true },
  { id: "glm-4.6", contextWindow: 202752, maxTokens: 8192, reasoning: true, vision: false },
  { id: "glm-4.7", contextWindow: 202752, maxTokens: 8192, reasoning: true, vision: false },
  { id: "glm-5", contextWindow: 202752, maxTokens: 8192, reasoning: true, vision: false },
  { id: "glm-5.1", contextWindow: 202752, maxTokens: 8192, reasoning: true, vision: false },
  { id: "gpt-oss:20b", contextWindow: 131072, maxTokens: 8192, reasoning: true, vision: false },
  { id: "gpt-oss:120b", contextWindow: 131072, maxTokens: 8192, reasoning: true, vision: false },
  { id: "kimi-k2.5", contextWindow: 262144, maxTokens: 8192, reasoning: true, vision: true },
  { id: "kimi-k2.6", contextWindow: 262144, maxTokens: 8192, reasoning: true, vision: true },
  { id: "minimax-m2", contextWindow: 204800, maxTokens: 8192, reasoning: true, vision: false },
  { id: "minimax-m2.1", contextWindow: 204800, maxTokens: 8192, reasoning: false, vision: false },
  { id: "minimax-m2.5", contextWindow: 202752, maxTokens: 8192, reasoning: true, vision: false },
  { id: "minimax-m2.7", contextWindow: 204800, maxTokens: 8192, reasoning: true, vision: false },
  { id: "ministral-3:3b", contextWindow: 262144, maxTokens: 8192, reasoning: false, vision: true },
  { id: "ministral-3:8b", contextWindow: 262144, maxTokens: 8192, reasoning: false, vision: true },
  { id: "ministral-3:14b", contextWindow: 262144, maxTokens: 8192, reasoning: false, vision: true },
  {
    id: "mistral-large-3:675b",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: false,
    vision: true,
  },
  {
    id: "nemotron-3-nano:30b",
    contextWindow: 1048576,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    id: "nemotron-3-super",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    id: "qwen3-coder-next",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: false,
    vision: false,
  },
  {
    id: "qwen3-coder:480b",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: false,
    vision: false,
  },
  { id: "qwen3-next:80b", contextWindow: 262144, maxTokens: 8192, reasoning: true, vision: false },
  { id: "qwen3-vl:235b", contextWindow: 262144, maxTokens: 8192, reasoning: true, vision: true },
  {
    id: "qwen3-vl:235b-instruct",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: true,
  },
  { id: "qwen3.5:397b", contextWindow: 262144, maxTokens: 8192, reasoning: true, vision: true },
  { id: "rnj-1:8b", contextWindow: 32768, maxTokens: 8192, reasoning: false, vision: false },
] as const satisfies readonly OllamaCloudModel[];

/**
 * Literal-string union of every model ID in the curated list. Use this in
 * resolvers, agent templates, and anywhere else that hard-codes an Ollama
 * Cloud model — TypeScript will then refuse to compile if you reference a
 * model that's been removed (the `llama3.3:70b → HTTP 404` bug from
 * v0.5.0 staging would have failed at the type level).
 */
export type OllamaCloudModelId = (typeof TOOL_CAPABLE_OLLAMA_CLOUD_MODELS)[number]["id"];

/** Just the IDs — used by the `/v1/models` transform and fallback list. */
export const TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS: readonly OllamaCloudModelId[] =
  TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.map((m) => m.id);

/**
 * Subset of IDs that accept image input. Used by the vision-capability check.
 *
 * Typed as `Set<string>` (not `Set<OllamaCloudModelId>`) because callers
 * pass model strings of unknown provenance (e.g. names returned from
 * OpenClaw's runtime, user input). `Set.has` is strict on its element type
 * in modern TS; widening here keeps the call sites simple without
 * sacrificing correctness — the set still only ever contains curated IDs.
 */
export const VISION_OLLAMA_CLOUD_MODEL_IDS: ReadonlySet<string> = new Set(
  TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.filter((m) => m.vision).map((m) => m.id)
);

/** Zero-cost config written to the OpenClaw models list — Ollama Cloud is
 * subscription-billed, not per-token, so per-token pricing would be misleading. */
export const OLLAMA_CLOUD_COST = ZERO_COST;

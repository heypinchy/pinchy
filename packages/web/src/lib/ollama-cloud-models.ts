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
 * Source priority for contextWindow: Ollama's own `/api/show` beats the
 * ollama.com/library/<name> page and the registry manifest when they
 * disagree. The library page is a marketing figure; `/api/show` is what the
 * runtime enforces. Check a value with:
 *
 *     ollama show <id>:cloud     # "context length" row
 *
 * deepseek-v4-pro was the confirmed example (since retired, 2026-11-16):
 * library page and manifest both said 1M, `/api/show` said 524288, and 524288
 * was the value here. Don't "reconcile" a `/api/show`-sourced
 * value back to the library page — re-run the command instead.
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
  /** Native context window in tokens. Source: `ollama show <name>:cloud`
   * (i.e. `/api/show`), which wins over the library page when they disagree —
   * see the source-priority note in the file header. */
  contextWindow: number;
  /** Optional Pinchy policy cap on the *effective* runtime context budget,
   * below the native contextWindow. Emitted as OpenClaw's
   * `models.providers.*.models[].contextTokens`, which the runtime budgets
   * compaction against (resolveContextWindowInfo, source "modelsConfig") while
   * contextWindow stays the honest native size. Set ONLY where a model's
   * quality degrades well before its advertised window — deepseek-v4-pro
   * (retired 2026-11-16) was the example, capped at 131072.
   *
   * NOTE: this is a *static budget cap* (config input) and is a different
   * concept from the per-turn `context_tokens` / `contextTokens` in
   * usage-per-turn.ts / db/schema.ts, which is the *measured* context size of a
   * turn (#767 observability). Same word, opposite direction — don't conflate. */
  contextTokens?: number;
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
    id: "gemma4:31b",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: true,
  },
  {
    // GLM-5.2, verified against the live API on 2026-06-17: structured
    // tool_call in round 1 plus a clean multi-turn follow-up (HTTP 200 with a
    // coherent answer after a tool result), and the /v1/chat/completions
    // endpoint returns HTTP 400 "this model does not support image input" —
    // text-only, like the rest of the GLM line. Library page: 976K context
    // ("NK" = N×1024 → 999424), tags "tools thinking cloud", Text-only input.
    id: "glm-5.2",
    contextWindow: 999424,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    id: "gpt-oss:20b",
    contextWindow: 131072,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    id: "gpt-oss:120b",
    contextWindow: 131072,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    id: "kimi-k2.6",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: true,
  },
  {
    // Tools verified 4/4 rounds (structured tool_call + clean multi-turn,
    // 2026-06-25) — reliably tool-capable, no multi-turn-500 regression.
    // `reasoning:true` from the library "thinking" tag (kimi-k2.6 parity).
    //
    // vision:true since 2026-07-30. It was false from 2026-06-25, when
    // /v1/chat/completions HTTP 500'd on every image_url payload (2 rounds).
    // Re-probed 2026-07-30 with a 512x512 PNG carrying a random 4-digit number
    // and a coloured circle: HTTP 200 and BOTH read correctly in 6/6 trials.
    // Guessing the number alone is ~1/9000 per trial, so this is real sight,
    // not a lucky pass — the serving path was fixed upstream.
    //
    // Read the old 500 in the light of the fixture bug fixed in the same
    // change: verify-ollama-cloud-vision.mjs pinned a 64x64 PNG that Ollama's
    // decoders now refuse outright, and this model still 500s on it today. The
    // 6/6 above used a real image, which is why the probe now sends 512x512.
    id: "kimi-k2.7-code",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: true,
  },
  {
    // ollama.com/library/minimax-m3 tags: "vision tools thinking cloud",
    // input "Text, Image", context "up to 1M with a guaranteed minimum of
    // 512K". Vision and tools were both confirmed against the live
    // /v1/chat/completions endpoint (reads a random 4-digit number and the
    // circle color correctly across distinct images; emits structured
    // tool_calls). We use the guaranteed 512K floor as the pruning hint so
    // context trimming kicks in before the smallest promised limit.
    id: "minimax-m3",
    contextWindow: 524288,
    maxTokens: 8192,
    reasoning: true,
    vision: true,
  },
  {
    id: "nemotron-3-super",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    // Probed clean against the live API on 2026-06-11: structured tool_calls
    // in 4/4 single-turn rounds plus a clean multi-turn follow-up. Text-only
    // input; library page: 256K context, "thinking" + "tools" tags.
    id: "nemotron-3-ultra",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
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

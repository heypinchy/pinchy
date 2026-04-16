/**
 * The canonical list of tool-capable Ollama Cloud models Pinchy surfaces.
 *
 * Source of truth: each model's "tools" capability tag on its
 * ollama.com/library/<name> page. The aggregate page search?c=tools&c=cloud
 * is incomplete — it omits gpt-oss, qwen3-vl, mistral-large-3, and others —
 * so do NOT treat the search URL as the source of truth.
 *
 * Context windows follow Ollama's "NK" = N * 1024 convention (verified by
 * cross-checking known models like "160K" → 163840). Pinchy writes these
 * hints into the OpenClaw config so context pruning can kick in before
 * requests bump into the real provider limit.
 *
 * When Ollama adds, removes, or resizes a model, update this file — the
 * ALLOWED_CLOUD_MODELS filter, the fallback list for the model picker, and
 * the OpenClaw config are all derived from it.
 */

export interface OllamaCloudModel {
  /** ID exactly as returned by https://ollama.com/v1/models (no ":cloud" suffix). */
  id: string;
  /** Native context window in tokens (from ollama.com/library/<name>). */
  contextWindow: number;
  /** Pinchy's max output tokens hint. Ollama doesn't publish this, so we use
   * the output-heavy value for Gemini Flash and a conservative 8192 elsewhere. */
  maxTokens: number;
}

export const TOOL_CAPABLE_OLLAMA_CLOUD_MODELS: readonly OllamaCloudModel[] = [
  { id: "deepseek-v3.1:671b", contextWindow: 163840, maxTokens: 8192 },
  { id: "deepseek-v3.2", contextWindow: 163840, maxTokens: 8192 },
  { id: "devstral-2:123b", contextWindow: 262144, maxTokens: 8192 },
  { id: "devstral-small-2:24b", contextWindow: 393216, maxTokens: 8192 },
  { id: "gemini-3-flash-preview", contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemma4:31b", contextWindow: 262144, maxTokens: 8192 },
  { id: "glm-4.6", contextWindow: 202752, maxTokens: 8192 },
  { id: "glm-4.7", contextWindow: 202752, maxTokens: 8192 },
  { id: "glm-5", contextWindow: 202752, maxTokens: 8192 },
  { id: "glm-5.1", contextWindow: 202752, maxTokens: 8192 },
  { id: "gpt-oss:20b", contextWindow: 131072, maxTokens: 8192 },
  { id: "gpt-oss:120b", contextWindow: 131072, maxTokens: 8192 },
  { id: "kimi-k2-thinking", contextWindow: 262144, maxTokens: 8192 },
  { id: "kimi-k2.5", contextWindow: 262144, maxTokens: 8192 },
  { id: "minimax-m2", contextWindow: 204800, maxTokens: 8192 },
  { id: "minimax-m2.1", contextWindow: 204800, maxTokens: 8192 },
  { id: "minimax-m2.5", contextWindow: 202752, maxTokens: 8192 },
  { id: "minimax-m2.7", contextWindow: 204800, maxTokens: 8192 },
  { id: "ministral-3:3b", contextWindow: 262144, maxTokens: 8192 },
  { id: "ministral-3:8b", contextWindow: 262144, maxTokens: 8192 },
  { id: "ministral-3:14b", contextWindow: 262144, maxTokens: 8192 },
  { id: "mistral-large-3:675b", contextWindow: 262144, maxTokens: 8192 },
  { id: "nemotron-3-nano:30b", contextWindow: 1048576, maxTokens: 8192 },
  { id: "nemotron-3-super", contextWindow: 262144, maxTokens: 8192 },
  { id: "qwen3-coder-next", contextWindow: 262144, maxTokens: 8192 },
  { id: "qwen3-coder:480b", contextWindow: 262144, maxTokens: 8192 },
  { id: "qwen3-next:80b", contextWindow: 262144, maxTokens: 8192 },
  { id: "qwen3-vl:235b", contextWindow: 262144, maxTokens: 8192 },
  { id: "qwen3-vl:235b-instruct", contextWindow: 262144, maxTokens: 8192 },
  { id: "qwen3.5:397b", contextWindow: 262144, maxTokens: 8192 },
  { id: "rnj-1:8b", contextWindow: 32768, maxTokens: 8192 },
];

/** Just the IDs — used by the `/v1/models` transform and fallback list. */
export const TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS = TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.map(
  (m) => m.id
);

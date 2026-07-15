/**
 * Embedding client for the knowledge base's dense vectors (bge-m3, 1024-dim).
 *
 * The embedding model is fixed (bge-m3), independent of any agent's chat
 * model, so this client takes its own config rather than reading agent
 * config or process.env. Mirrors the Ollama call pattern in
 * packages/plugins/pinchy-files/pdf-vision-api.ts (describeViaOllama), but
 * targets Ollama's batch embeddings endpoint instead of chat completions.
 */

export interface EmbeddingConfig {
  /** Ollama-compatible base URL, e.g. "http://ollama:11434". Unused when provider === "local". */
  baseUrl: string;
  /** Defaults to "bge-m3". */
  model?: string;
  /**
   * Defaults to "ollama" (local, no API key needed). "local" switches to an
   * in-process node-llama-cpp backend instead of an HTTP call — see
   * `modelPath`.
   */
  provider?: string;
  /** Only attached as a Bearer token when provider !== "ollama". */
  apiKey?: string;
  /**
   * Filesystem path to a GGUF model file. REQUIRED when `provider ===
   * "local"`; ignored otherwise. Loaded in-process via node-llama-cpp
   * instead of calling out to Ollama over HTTP.
   */
  modelPath?: string;
  /**
   * Optional expected vector width. When set, a returned width other than
   * this throws a clear error naming both expected and actual dims — the KB
   * pipeline passes `EMBEDDING_DIMENSIONS` (1024) so a wrong model surfaces
   * here, not as an opaque `vector(1024)` insert failure at Postgres. Unset =
   * no dimension enforcement (the client stays model-agnostic).
   */
  expectedDim?: number;
  /**
   * keep_alive for the Ollama model (seconds, a duration string like "30m",
   * or -1 to pin the model resident indefinitely). Defaults to -1: the
   * embedding model must NOT idle-unload, otherwise the first KB query after
   * idle hits a ~25s cold load, the search times out, and the agent wrongly
   * reports the knowledge base as empty. Unused when provider === "local".
   */
  keepAlive?: number | string;
}

const DEFAULT_MODEL = "bge-m3";

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

/**
 * Validate the shape of a batch of embedding vectors the same way
 * regardless of which backend produced them (Ollama HTTP or the in-process
 * node-llama-cpp path): right count, consistent width across the batch, and
 * (when `cfg.expectedDim` is set) the expected width.
 */
function assertEmbeddingShape(
  embeddings: unknown,
  expectedCount: number,
  cfg: EmbeddingConfig,
  sourceLabel: string
): number[][] {
  if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
    throw new Error(
      `${sourceLabel} returned a malformed response: missing or mismatched 'embeddings' ` +
        `(expected ${expectedCount})`
    );
  }

  const dim = Array.isArray(embeddings[0]) ? embeddings[0].length : undefined;
  const allVectors = embeddings.every(
    (vec): vec is number[] => Array.isArray(vec) && vec.length === dim
  );
  if (!allVectors) {
    throw new Error(`${sourceLabel} returned vectors with inconsistent dimensions`);
  }

  if (cfg.expectedDim != null && dim !== cfg.expectedDim) {
    const modelLabel =
      cfg.model ?? (cfg.provider === "local" ? "the configured local GGUF model" : DEFAULT_MODEL);
    throw new Error(
      `${sourceLabel} returned ${dim}-dim vectors but expected ${cfg.expectedDim} ` +
        `(model "${modelLabel}" is not the configured embedding model, ` +
        `or its dimensions differ from the kb_chunks.embedding column width)`
    );
  }

  return embeddings as number[][];
}

// node-llama-cpp loading is expensive (~1.6s) and must happen at most once
// per distinct GGUF file. Keyed by modelPath so different models each get
// their own context; the promise is cached (not just the resolved value) so
// concurrent callers during the initial load also await the same load
// rather than triggering it twice.
type LlamaEmbeddingContext = {
  getEmbeddingFor(text: string): Promise<{ vector: ArrayLike<number> }>;
};
const localEmbeddingContexts = new Map<string, Promise<LlamaEmbeddingContext>>();

function getLocalEmbeddingContext(modelPath: string): Promise<LlamaEmbeddingContext> {
  let contextPromise = localEmbeddingContexts.get(modelPath);
  if (!contextPromise) {
    contextPromise = (async () => {
      // Dynamic import only: node-llama-cpp loads a native .node addon, and
      // a static top-level import would pull it into every process that
      // imports this module — including the fast unit-test suite and
      // Ollama-only routes that never use the "local" provider.
      const { getLlama } = await import("node-llama-cpp");
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath });
      const ctx = await model.createEmbeddingContext();
      return ctx as unknown as LlamaEmbeddingContext;
    })();
    localEmbeddingContexts.set(modelPath, contextPromise);
  }
  return contextPromise;
}

/**
 * Embed a batch of texts in-process via node-llama-cpp, loading (and
 * memoizing) a GGUF model from `cfg.modelPath`. Sequential, not batched:
 * node-llama-cpp's embedding context processes one input at a time.
 */
async function embedTextsLocal(texts: string[], cfg: EmbeddingConfig): Promise<number[][]> {
  if (!cfg.modelPath) {
    throw new Error(
      `embedTexts: provider "local" requires cfg.modelPath (filesystem path to a GGUF model file)`
    );
  }

  const ctx = await getLocalEmbeddingContext(cfg.modelPath);

  const vectors: number[][] = [];
  for (const text of texts) {
    const { vector } = await ctx.getEmbeddingFor(text);
    vectors.push(Array.from(vector));
  }

  return assertEmbeddingShape(vectors, texts.length, cfg, "node-llama-cpp");
}

/**
 * Embed a batch of texts. Defaults to Ollama's `/api/embed` endpoint
 * (`{ model, input: string[] }` -> `{ embeddings: number[][] }`); when
 * `cfg.provider === "local"`, embeds in-process via node-llama-cpp instead
 * (see `embedTextsLocal`).
 */
export async function embedTexts(texts: string[], cfg: EmbeddingConfig): Promise<number[][]> {
  if (cfg.provider === "local") {
    return embedTextsLocal(texts, cfg);
  }

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/api/embed`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.provider && cfg.provider !== "ollama" && cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model ?? DEFAULT_MODEL,
      input: texts,
      keep_alive: cfg.keepAlive ?? -1,
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown error");
    throw new Error(`Ollama embeddings API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as OllamaEmbedResponse;
  return assertEmbeddingShape(data.embeddings, texts.length, cfg, "Ollama embeddings API");
}

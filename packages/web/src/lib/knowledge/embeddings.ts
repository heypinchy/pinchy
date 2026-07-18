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
  /**
   * Max inputs per Ollama `/api/embed` request. Ingest embeds a whole
   * document's chunks in ONE embedTexts() call, and a large PDF yields
   * hundreds — a single unbounded POST is what took the reindex down at a
   * 342-page document with `fetch failed`. Requests are issued sequentially
   * and their vectors concatenated in the original order. Defaults to 32.
   * Unused when provider === "local" (that path is already one input per call).
   */
  batchSize?: number;
  /**
   * Per-request abort timeout in ms for the Ollama path. A wedged embedding
   * connection otherwise stalls the whole (multi-hour) reindex with no upper
   * bound; aborting frees the job to fail cleanly and release its slot.
   * Defaults to 180000. Unused when provider === "local".
   */
  timeoutMs?: number;
}

const DEFAULT_MODEL = "bge-m3";
/**
 * See EmbeddingConfig.batchSize. Bounded so one large document can't ship its
 * whole chunk set in a single POST. bge-m3 latency measured linear in batch
 * size (~1.3-1.5s/chunk on a loaded CPU), so a larger batch buys no throughput
 * — only a bigger payload and a longer request. 32 keeps each POST small and
 * fast while matching the batch size the pipeline ran at historically.
 */
const DEFAULT_BATCH_SIZE = 32;
/**
 * See EmbeddingConfig.timeoutMs. The worst 32-batch measured on a loaded CPU
 * was ~42s; add a ~25s cold model load and 180s clears the realistic worst
 * case with margin, while still bounding a genuinely dead connection (which
 * hangs forever) rather than policing slow-but-progressing embedding.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

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
 * POST one bounded batch to Ollama's `/api/embed`, aborting if it stalls past
 * `timeoutMs` — whether the stall is at connect, waiting for headers, or
 * reading the body (fetch() resolves once headers arrive, so the body read
 * needs the same bound). Kept separate from embedTexts so the batching loop
 * stays a plain slice-and-concat; this is the single HTTP boundary where a
 * timeout and the non-2xx / shape checks belong.
 */
async function embedBatchViaOllama(
  batch: string[],
  url: string,
  headers: Record<string, string>,
  cfg: EmbeddingConfig,
  timeoutMs: number
): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model ?? DEFAULT_MODEL,
        input: batch,
        keep_alive: cfg.keepAlive ?? -1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text().catch(() => "unknown error");
      throw new Error(`Ollama embeddings API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as OllamaEmbedResponse;
    return assertEmbeddingShape(data.embeddings, batch.length, cfg, "Ollama embeddings API");
  } catch (err) {
    // The timeout aborts the request whether it stalls mid-fetch or mid
    // body-read; both surface here as an AbortError. Convert either to a clear
    // timeout, distinct from a genuine network failure ("fetch failed") — which
    // stays as-is so a real connection error still reads as one.
    if (controller.signal.aborted) {
      throw new Error(`Ollama embeddings request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed a batch of texts. Defaults to Ollama's `/api/embed` endpoint
 * (`{ model, input: string[] }` -> `{ embeddings: number[][] }`); when
 * `cfg.provider === "local"`, embeds in-process via node-llama-cpp instead
 * (see `embedTextsLocal`).
 *
 * The Ollama path splits `texts` into sequential requests of at most
 * `cfg.batchSize` (default 32) and concatenates their vectors in the original
 * order — ingest hands a whole document's chunks in one call, so an unbounded
 * POST here is what a large PDF used to break the reindex on.
 */
export async function embedTexts(texts: string[], cfg: EmbeddingConfig): Promise<number[][]> {
  if (cfg.provider === "local") {
    return embedTextsLocal(texts, cfg);
  }

  if (texts.length === 0) return [];

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/api/embed`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.provider && cfg.provider !== "ollama" && cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  const batchSize = cfg.batchSize ?? DEFAULT_BATCH_SIZE;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const all: number[][] = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const vectors = await embedBatchViaOllama(batch, url, headers, cfg, timeoutMs);
    for (const vector of vectors) all.push(vector);
  }

  // Each batch is validated internally, but not against the others: a model
  // swap mid-reindex could hand batch 2 a different width than batch 1. Revalidate
  // the concatenation once so mixed-width vectors fail here, not opaquely at the
  // kb_chunks embedding insert.
  return assertEmbeddingShape(all, texts.length, cfg, "Ollama embeddings API");
}

/**
 * Embedding client for the knowledge base's dense vectors. Backend-agnostic:
 * the default path targets Ollama's batch embeddings endpoint (model defaults
 * to bge-m3), and `provider: "local"` switches to an in-process node-llama-cpp
 * GGUF instead. The KB itself now uses the local path (embeddinggemma-300m,
 * 768-dim — see kb-embedder.ts / #715); the Ollama path stays for callers that
 * still point at a configured endpoint.
 *
 * The embedding model is independent of any agent's chat model, so this client
 * takes its own config rather than reading agent config or process.env. The
 * Ollama path mirrors the call pattern in
 * packages/plugins/pinchy-files/pdf-vision-api.ts (describeViaOllama), but
 * targets Ollama's batch embeddings endpoint instead of chat completions.
 */
import { isMap, processWideCache } from "@/lib/process-wide-cache";

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
   * pipeline passes `EMBEDDING_DIMENSIONS` (768) so a wrong model surfaces
   * here, not as an opaque `vector(768)` insert failure at Postgres. Unset =
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
  /**
   * llama.cpp worker threads for the in-process embedding context. Only read
   * when provider === "local", and only when the context is first created —
   * the context is shared process-wide, so the first caller's value sticks.
   * Unset = node-llama-cpp's own default (6), which oversubscribes a small box:
   * see resolveEmbeddingThreads() in kb-embedder.ts for why that matters.
   */
  threads?: number;
}

const DEFAULT_MODEL = "bge-m3";
/**
 * See EmbeddingConfig.batchSize. Bounded so one large document can't ship its
 * whole chunk set in a single POST. bge-m3 latency measured linear in batch
 * size (~1.3-1.5s/chunk on a loaded CPU), so a larger batch buys no throughput
 * — only a bigger payload and a longer request. 32 keeps each POST small and
 * fast while matching the batch size the pipeline ran at historically.
 *
 * Exported because ingest.ts slices its embed calls at exactly this size to
 * report progress inside a long document (#907): sliced at the size the
 * embedder would have sliced at anyway, that reporting changes the shape of no
 * request. A second literal there would let the two drift, and the drift would
 * be silent — a smaller slice caps a configured `batchSize` without saying so.
 */
export const DEFAULT_BATCH_SIZE = 32;
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
 * The embedder cannot embed anything right now: the model does not load, the
 * endpoint is unreachable or times out, or it answers with vectors of the wrong
 * shape. One outage, not a property of the text it was handed — so ingest stops
 * the run on it instead of counting every remaining file as failed (#1380).
 *
 * An input the embedder refuses ("Input is longer than the context size") is
 * deliberately NOT one: that is the file's failure, and the run goes on.
 */
export class EmbedderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbedderUnavailableError";
  }
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
    throw new EmbedderUnavailableError(
      `${sourceLabel} returned a malformed response: missing or mismatched 'embeddings' ` +
        `(expected ${expectedCount})`
    );
  }

  const dim = Array.isArray(embeddings[0]) ? embeddings[0].length : undefined;
  const allVectors = embeddings.every(
    (vec): vec is number[] => Array.isArray(vec) && vec.length === dim
  );
  if (!allVectors) {
    throw new EmbedderUnavailableError(
      `${sourceLabel} returned vectors with inconsistent dimensions`
    );
  }

  if (cfg.expectedDim != null && dim !== cfg.expectedDim) {
    const modelLabel =
      cfg.model ?? (cfg.provider === "local" ? "the configured local GGUF model" : DEFAULT_MODEL);
    throw new EmbedderUnavailableError(
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
// rather than triggering it twice. A load that fails is evicted after
// LOCAL_MODEL_RETRY_COOLDOWN_MS, so a later call tries again instead of every
// search failing until a restart.
//
// Sharing ONE context across concurrent callers is safe: in the web process
// the KB search route (one query embed per request) and the KB index worker
// (a sequential embed loop per document) can call getEmbeddingFor on this
// same context at the same time. node-llama-cpp serializes each call
// internally (an "evaluate" lock that erases the context token range before
// every input), so concurrent embeds queue and run one at a time instead of
// corrupting each other's state — no external mutex needed here.
//
// That only holds if there really is ONE context, which a module-level Map
// does not give: the search route runs in Next's route bundle and the index
// worker in the custom server, two module instances in one process (see
// process-wide-cache.ts). Each loaded its own model and context — twice the
// RAM, and two evaluate locks, so a search and a reindex ran their embeddings
// at the same time on the same cores instead of queueing. Hence globalThis.
/**
 * How long a failed local model load stays failed before the next call tries
 * again. Short enough that a transient failure (memory pressure during a big
 * conversion) heals within a minute; long enough that a permanent one (a
 * corrupt GGUF) costs one load per minute rather than one per search.
 */
export const LOCAL_MODEL_RETRY_COOLDOWN_MS = 60_000;

type LlamaEmbeddingContext = {
  getEmbeddingFor(text: string): Promise<{ vector: ArrayLike<number> }>;
};

/** The loaded model's tokenizer — what `fitTextsForEmbedding` measures with. */
type LlamaModelHandle = {
  trainContextSize?: number;
  tokenize(text: string, specialTokens?: boolean): readonly unknown[];
  detokenize(tokens: readonly unknown[], specialTokens?: boolean): string;
};

/**
 * The context together with the model it was created from. The context alone
 * cannot say how long an input may be; the model's tokenizer can, and measuring
 * with anything else is how #1380 happened.
 */
interface LocalEmbedder {
  context: LlamaEmbeddingContext;
  model: LlamaModelHandle;
}

function localEmbeddingContexts(): Map<string, Promise<LocalEmbedder>> {
  // A new key, not the old one: a process that cached the old value shape
  // under the old key must never hand it back here.
  return processWideCache("__pinchyLocalEmbedders", () => new Map(), isMap);
}

function getLocalEmbeddingContext(
  modelPath: string,
  threads: number | undefined
): Promise<LocalEmbedder> {
  const contexts = localEmbeddingContexts();
  let contextPromise = contexts.get(modelPath);
  if (!contextPromise) {
    const loading = (async () => {
      // Dynamic import only: node-llama-cpp loads a native .node addon, and
      // a static top-level import would pull it into every process that
      // imports this module — including the fast unit-test suite and
      // Ollama-only routes that never use the "local" provider.
      const { getLlama } = await import("node-llama-cpp");
      const llama = await getLlama().catch(unavailable);
      const model = await llama.loadModel({ modelPath }).catch(unavailable);
      try {
        const ctx = await model.createEmbeddingContext(threads != null ? { threads } : {});
        return {
          context: ctx as unknown as LlamaEmbeddingContext,
          model: model as unknown as LlamaModelHandle,
        };
      } catch (err) {
        // The ~300 MB model is loaded; without a context nobody holds it, and
        // a retry would load another one next to it. Fire-and-forget, so a
        // dispose that throws or never settles can neither replace this error
        // nor hold the load (and its cooldown) open.
        void Promise.resolve()
          .then(() => model.dispose())
          .catch(() => {});
        return unavailable(err);
      }
    })();
    contextPromise = loading;
    contexts.set(modelPath, loading);
    loading.catch(() => {
      // Keep the failure cached for a while, so a persistently broken load
      // fails every search fast instead of loading the model again for each.
      const evict = setTimeout(() => {
        // Defensive: only this path sets the key today, but never let an old
        // timer evict a newer load.
        if (contexts.get(modelPath) === loading) contexts.delete(modelPath);
      }, LOCAL_MODEL_RETRY_COOLDOWN_MS);
      evict.unref?.();
    });
  }
  return contextPromise;
}

/** Rethrows a model-load failure as the outage it is, keeping its message. */
function unavailable(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  throw new EmbedderUnavailableError(message, { cause: err });
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

  const { context: ctx } = await getLocalEmbeddingContext(cfg.modelPath, cfg.threads);

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
      const message = `Ollama embeddings API error (${response.status}): ${error}`;
      // A 4xx is Ollama refusing THIS input; a 5xx (or a 429) is Ollama.
      if (response.status >= 500 || response.status === 429) {
        throw new EmbedderUnavailableError(message);
      }
      throw new Error(message);
    }

    const data = (await response.json()) as OllamaEmbedResponse;
    return assertEmbeddingShape(data.embeddings, batch.length, cfg, "Ollama embeddings API");
  } catch (err) {
    // The timeout aborts the request whether it stalls mid-fetch or mid
    // body-read; both surface here as an AbortError. Convert either to a clear
    // timeout, distinct from a genuine network failure ("fetch failed") — which
    // stays as-is so a real connection error still reads as one.
    if (controller.signal.aborted) {
      throw new EmbedderUnavailableError(
        `Ollama embeddings request timed out after ${timeoutMs}ms`
      );
    }
    // fetch() rejects with a TypeError ("fetch failed") when it cannot reach
    // the endpoint at all — a connection refused, a DNS failure.
    if (err instanceof TypeError) {
      throw new EmbedderUnavailableError(err.message, { cause: err });
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

/** Counts and cuts text in the embedding model's own tokens. */
export interface EmbeddingTokenizer {
  tokenize(text: string): readonly unknown[];
  detokenize(tokens: readonly unknown[]): string;
}

/**
 * Most characters one token may stand for when estimating how much text to
 * measure for the next piece. A cap, not a guess: a window this wide holds at
 * least a budget's worth of tokens for any ordinary text, and one enormous line
 * (a whole page without a break) is never re-measured in full for every piece.
 */
const MAX_CHARS_PER_TOKEN = 16;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Where to end a piece that starts at `start` and may reach at most `limit`
 * (exclusive). Prefers, in order: a paragraph break, a line break (chunk.ts
 * keeps a table line whole on purpose), a sentence end, a space — each only in
 * the back half of the window, so a break near the start does not leave a
 * sliver of a piece. Otherwise the last grapheme boundary: never inside a
 * character, never between a letter and its combining accent.
 */
function findCut(text: string, start: number, limit: number): number {
  const floor = start + Math.max(1, Math.floor((limit - start) / 2));
  let line = -1;
  let sentence = -1;
  let space = -1;
  for (let i = Math.min(limit, text.length - 1); i >= floor; i--) {
    const ch = text.charAt(i);
    if (ch === "\n") {
      // A blank line: cut at the first of its two line breaks.
      let j = i - 1;
      while (j >= floor && " \t\r".includes(text.charAt(j))) j--;
      if (j >= floor && text.charAt(j) === "\n") return j;
      if (line === -1) line = i;
    } else if (/\s/.test(ch)) {
      if (sentence === -1 && /[.!?;:]/.test(text.charAt(i - 1))) sentence = i;
      if (space === -1) space = i;
    }
  }
  for (const cut of [line, sentence, space]) if (cut > start) return cut;

  // No break in reach: the last grapheme boundary at or before the limit, or —
  // a single grapheme longer than the window — the first one after the start.
  // Segmentation starts at `start`, which is a real boundary: the segmenter
  // treats a slice's start as one, so starting mid-text could pair a flag's
  // regional indicators the wrong way or open inside a long combining cluster.
  const from = start;
  let best = -1;
  for (const { index } of graphemes.segment(text.slice(from, Math.min(text.length, limit + 64)))) {
    if (index === 0) continue; // the slice's own start, which may sit inside a grapheme
    const at = from + index;
    if (at > start && at <= limit) best = at;
    if (at > limit) {
      if (best === -1) best = at;
      break;
    }
  }
  if (best !== -1) return best;
  // A grapheme longer than the slice: at least never split a surrogate pair.
  const at = Math.min(text.length, limit);
  return /[\uDC00-\uDFFF]/.test(text.charAt(at)) ? at + 1 : at;
}

/**
 * Cuts `text` into pieces of at most `maxTokens` tokens each, measured with the
 * tokenizer that will embed them. A text that fits comes back alone and
 * unchanged.
 *
 * The pieces are cut from the ORIGINAL text, at a paragraph, line, sentence,
 * word or grapheme boundary; the tokenizer only measures. Decoding a window of
 * tokens back to text — what this did before — cuts a byte-fallback character
 * between its bytes and stores U+FFFD, and the citation viewer can then no
 * longer find the chunk on its page (`locatePassage` needs it verbatim). So
 * every piece is a slice of the text, in order, with only whitespace between
 * two of them.
 *
 * The pieces do not overlap. The chunker already overlaps chunks by 15%; a
 * piece of an over-long chunk is a rare case, and overlap there would only
 * store the same words twice under the same locator.
 *
 * Each piece is measured as cut, and a cut that does not fit is moved back
 * until it does: the token count of a prefix is not monotonic in its length (a
 * merge that only forms once a word is whole), so the estimate is a start, not
 * a promise.
 */
export function splitToTokenBudget(
  text: string,
  tokenizer: EmbeddingTokenizer,
  maxTokens: number
): string[] {
  const budget = Math.max(1, Math.floor(maxTokens));
  if (tokenizer.tokenize(text).length <= budget) return [text];

  const windowChars = budget * MAX_CHARS_PER_TOKEN;
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    while (start < text.length && /\s/.test(text.charAt(start))) start++;
    if (start >= text.length) break;

    const windowEnd = Math.min(text.length, start + windowChars);
    const tokens = tokenizer.tokenize(text.slice(start, windowEnd));
    let limit =
      windowEnd === text.length && tokens.length <= budget
        ? text.length
        : start +
          Math.min(
            windowEnd - start,
            Math.max(1, tokenizer.detokenize(tokens.slice(0, budget)).length)
          );

    let cut = limit === text.length ? limit : findCut(text, start, limit);
    let piece = text.slice(start, cut).trimEnd();
    while (tokenizer.tokenize(piece).length > budget) {
      limit = start + Math.max(1, Math.floor((cut - start) * 0.9));
      const shorter = findCut(text, start, limit);
      if (shorter >= cut) break; // one grapheme over the budget: nothing smaller to cut
      cut = shorter;
      piece = text.slice(start, cut).trimEnd();
    }
    pieces.push(piece);
    start = cut;
  }
  return pieces;
}

/**
 * Tokens kept free under the context size. node-llama-cpp compares an input's
 * length with the context BEFORE it adds the BOS/EOS tokens the model also
 * needs room for, so an input exactly at the limit passes the check and then
 * does not fit.
 */
const CONTEXT_HEADROOM_TOKENS = 4;

/**
 * Characters per piece on the Ollama path, which has no tokenizer to measure
 * with. No token is shorter than one character, so 2048 characters stay within
 * Ollama's default 2048-token context whatever the text — where Ollama would
 * otherwise truncate a longer input silently and embed only its beginning.
 */
const OLLAMA_MAX_INPUT_CHARS = 2048;

/**
 * node-llama-cpp's default batch size when it is not readable: the context is
 * created without one, which the library resolves to min(contextSize, 512).
 */
const DEFAULT_BATCH_TOKENS = 512;

/** The input budget of the loaded context, in the model's tokens. */
function localTokenBudget(embedder: LocalEmbedder): number {
  // node-llama-cpp exposes the context and batch size only on the private
  // context it wraps; the model's training context is the upper bound an
  // "auto" context is sized against, and the honest fallback when that field
  // moves.
  //
  // The batch is the binding limit, not the context: an input longer than the
  // batch is decoded in several calls, and the pooled vector then reflects only
  // the last one — the head of the text drops out of its own embedding with no
  // error (measured on embeddinggemma: cosine 0.98 to the tail, 0.64 to the
  // head, #1380).
  const llamaContext = (
    embedder.context as { _llamaContext?: { contextSize?: unknown; batchSize?: unknown } }
  )._llamaContext;
  const isSize = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  const batch = isSize(llamaContext?.batchSize) ? llamaContext.batchSize : DEFAULT_BATCH_TOKENS;
  const candidates = [llamaContext?.contextSize, embedder.model.trainContextSize, batch].filter(
    isSize
  );
  const size = Math.min(...candidates);
  return Math.max(1, size - CONTEXT_HEADROOM_TOKENS);
}

/**
 * Cuts every text the embedder could not take whole into pieces it can (#1380).
 * Returns one list of pieces per input, in order: a text that fits is a list of
 * one, itself. `embedTexts` stays one vector per input; the caller decides what
 * a piece is — ingest stores each as a chunk of its own, under the original
 * chunk's locator.
 *
 * The chunker sizes chunks by a 4-characters-per-token estimate, and keeps a
 * single over-long line whole. A table of part numbers tokenizes far denser
 * than that, so a chunk the estimate calls 500 tokens can be several thousand
 * — and the local context refuses it outright.
 */
export async function fitTextsForEmbedding(
  texts: string[],
  cfg: EmbeddingConfig
): Promise<string[][]> {
  if (cfg.provider === "local") {
    if (!cfg.modelPath) {
      throw new Error(
        `fitTextsForEmbedding: provider "local" requires cfg.modelPath (filesystem path to a GGUF model file)`
      );
    }
    const embedder = await getLocalEmbeddingContext(cfg.modelPath, cfg.threads);
    const budget = localTokenBudget(embedder);
    const tokenizer: EmbeddingTokenizer = {
      tokenize: (text) => embedder.model.tokenize(text, false),
      detokenize: (tokens) => embedder.model.detokenize(tokens, false),
    };
    return texts.map((text) => splitToTokenBudget(text, tokenizer, budget));
  }

  const byChar: EmbeddingTokenizer = {
    tokenize: (text) => Array.from(text),
    detokenize: (tokens) => (tokens as string[]).join(""),
  };
  return texts.map((text) => splitToTokenBudget(text, byChar, OLLAMA_MAX_INPUT_CHARS));
}

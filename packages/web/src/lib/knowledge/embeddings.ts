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
  /** Ollama-compatible base URL, e.g. "http://ollama:11434". */
  baseUrl: string;
  /** Defaults to "bge-m3". */
  model?: string;
  /** Defaults to "ollama" (local, no API key needed). */
  provider?: string;
  /** Only attached as a Bearer token when provider !== "ollama". */
  apiKey?: string;
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
   * reports the knowledge base as empty.
   */
  keepAlive?: number | string;
}

const DEFAULT_MODEL = "bge-m3";

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

/**
 * Embed a batch of texts via Ollama's `/api/embed` endpoint
 * (`{ model, input: string[] }` -> `{ embeddings: number[][] }`).
 */
export async function embedTexts(texts: string[], cfg: EmbeddingConfig): Promise<number[][]> {
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
  const embeddings = data.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(
      "Ollama embeddings API returned a malformed response: missing or mismatched 'embeddings'"
    );
  }

  const dim = Array.isArray(embeddings[0]) ? embeddings[0].length : undefined;
  const allVectors = embeddings.every(
    (vec): vec is number[] => Array.isArray(vec) && vec.length === dim
  );
  if (!allVectors) {
    throw new Error("Ollama embeddings API returned vectors with inconsistent dimensions");
  }

  if (cfg.expectedDim != null && dim !== cfg.expectedDim) {
    throw new Error(
      `Ollama embeddings API returned ${dim}-dim vectors but expected ${cfg.expectedDim} ` +
        `(model "${cfg.model ?? DEFAULT_MODEL}" is not the configured embedding model, ` +
        `or its dimensions differ from the kb_chunks.embedding column width)`
    );
  }

  return embeddings as number[][];
}

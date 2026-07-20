/**
 * The knowledge base's embedder wiring: embeddinggemma-300m loaded IN-PROCESS
 * via node-llama-cpp (768-dim), never over Ollama. Both KB embedding sites (the
 * index worker and the search route) resolve their config and their
 * availability gate from here, so the "how does the KB embed" decision lives in
 * one place — and switching off the Ollama dependency (#715) also dissolved the
 * setup friction where an embedding-only deployment could not configure the KB.
 *
 * Deliberate trade-off: embedding no longer runs in a separate Ollama process
 * but IN the web process, so the ~300 MB GGUF + node-llama-cpp native runtime
 * are resident in the server that also handles requests, and a large reindex's
 * embed loop is CPU work competing with request serving on the same box. For
 * single-box self-hosting (the target deployment) that is the point — one
 * self-contained container, no side-car — and the model loads lazily on first
 * embed (getLocalEmbeddingContext), so a deployment that never uses the KB
 * pays nothing.
 */
import { existsSync } from "node:fs";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_MODEL_PATH } from "./constants";
import type { EmbeddingConfig } from "./embeddings";

/**
 * The KB's fixed embedding config: embeddinggemma-300m via provider "local"
 * (in-process node-llama-cpp), 768-dim. `baseUrl` is required by the type but
 * unused on the local path.
 */
export function kbEmbeddingConfig(): EmbeddingConfig {
  return {
    baseUrl: "",
    provider: "local",
    model: EMBEDDING_MODEL,
    modelPath: EMBEDDING_MODEL_PATH,
    expectedDim: EMBEDDING_DIMENSIONS,
  };
}

/**
 * Is the bundled embeddinggemma GGUF present on disk? The image ships it
 * (Dockerfile.pinchy), so `false` means a broken build or mount — NOT an
 * operator choice — and the KB's ingest + search surface it as a clear error
 * instead of crashing mid-run when node-llama-cpp fails to open the file.
 */
export function kbEmbedderAvailable(): boolean {
  return existsSync(EMBEDDING_MODEL_PATH);
}

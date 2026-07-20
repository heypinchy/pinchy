/**
 * Single-tenant seam for the knowledge base. Pinchy has no `organizations`
 * table anywhere in the schema — one self-hosted deployment IS one org. The KB
 * design doc ("Architecture") describes the index as "korpus-/org-weit"
 * (corpus-/org-wide) across the whole deployment, with agents acting as
 * filtered views via `allowed_paths` — NOT as separate orgs.
 * `kb_documents.org_id` / `kb_chunks.org_id` exist to keep the retrieval SQL
 * future-proof for real multi-org tenancy, but nothing in the codebase
 * resolves a per-request org id today.
 *
 * This constant is that seam: EVERY ingest and EVERY retrieval in a single
 * Pinchy deployment must use the same value, so they always see the same
 * corpus. It lives here (not inline in a route) precisely so the ingest route
 * and the search route share ONE definition and cannot drift. If Pinchy ever
 * grows real multi-org tenancy, replace this constant with a real per-tenant
 * resolution — do NOT introduce a second constant.
 */
export const DEFAULT_ORG_ID = "default";

/**
 * Fixed embedding model for the knowledge base: embeddinggemma-300m, run
 * IN-PROCESS via node-llama-cpp (not over Ollama HTTP). This name is cosmetic
 * — it labels logs and error messages; the actual model loaded is the GGUF at
 * `EMBEDDING_MODEL_PATH`. The KB deliberately does NOT depend on a configured
 * Ollama endpoint (see #715): embedding is self-contained.
 */
export const EMBEDDING_MODEL = "embeddinggemma-300m";

/**
 * Filesystem path to the bundled embeddinggemma GGUF the KB embedder loads
 * in-process. Same pinned file the OpenClaw agent-memory feature already
 * bundles (Dockerfile.openclaw); Dockerfile.pinchy provisions it at this same
 * path for the web process the KB index worker + search route run in.
 * Env-overridable for local dev (point it at a GGUF you downloaded yourself).
 */
export const EMBEDDING_MODEL_PATH =
  process.env.KB_EMBEDDING_MODEL_PATH || "/opt/embedding-models/embeddinggemma-300m-qat-Q8_0.gguf";

/**
 * embeddinggemma-300m's output width. The `kb_chunks.embedding` column is
 * `vector(768)` (db/vector.ts imports THIS constant, so the two cannot drift),
 * so a model that returns any other width can only be inserted as an opaque
 * Postgres dimension-mismatch error. Callers pass this as
 * `embedTexts(..., { expectedDim: EMBEDDING_DIMENSIONS })` so a misconfigured
 * embedder fails with a clear, source-of-truth message at the embedding
 * boundary instead.
 */
export const EMBEDDING_DIMENSIONS = 768;

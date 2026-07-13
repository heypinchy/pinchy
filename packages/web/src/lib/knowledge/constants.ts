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

/** Fixed embedding model for the knowledge base (bge-m3, 1024-dim). */
export const EMBEDDING_MODEL = "bge-m3";

/**
 * bge-m3's output width. The `kb_chunks.embedding` column is `vector(1024)`
 * (see db/vector.ts), so a model that returns any other width can only be
 * inserted as an opaque Postgres dimension-mismatch error. Callers pass this
 * as `embedTexts(..., { expectedDim: EMBEDDING_DIMENSIONS })` so a
 * misconfigured embedder fails with a clear, source-of-truth message at the
 * embedding boundary instead. Keep in lockstep with `vector()`'s `vector(N)`.
 */
export const EMBEDDING_DIMENSIONS = 1024;

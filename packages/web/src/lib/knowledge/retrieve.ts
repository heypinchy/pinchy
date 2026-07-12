/**
 * Hybrid knowledge-base retrieval: pgvector semantic search + Postgres
 * full-text search, fused with Reciprocal Rank Fusion (RRF).
 *
 * Both arms independently rank the same org/status/path-scoped candidate
 * set of kb_chunks — the vector arm by cosine distance (`<=>`) against the
 * query embedding, the FTS arm by `ts_rank` against a `plainto_tsquery`
 * match on the generated `tsv` column — and are fused by summing
 * `1 / (rrfK + rank)` per chunk across whichever arm(s) it appears in. A
 * chunk that only shows up in one arm still contributes a (smaller) score,
 * so a strong lexical match with an unrelated embedding (or vice versa)
 * isn't dropped just because the other signal missed it.
 *
 * The embedder is dependency-injected (prod wires `embedTexts`, ./embeddings.ts)
 * so the integration suite stays hermetic — no Ollama required.
 */
import { sql } from "drizzle-orm";
import { sep } from "node:path";

import { db } from "@/db";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  text: string;
  sourcePath: string;
  page: number | null;
  /** Fused RRF score (higher is more relevant). Not a probability or a distance. */
  score: number;
}

export interface RetrieveDeps {
  /** Embeds the query into a single dense vector (bge-m3, 1024-dim). Prod: `(t) => embedTexts(t, embedCfg)`. */
  embed: (texts: string[]) => Promise<number[][]>;
}

export interface RetrieveOptions {
  /** Final number of fused results to return. */
  k?: number;
  /** Per-arm candidate depth before fusion. */
  candidateK?: number;
  /** RRF smoothing constant. */
  rrfK?: number;
}

const DEFAULT_K = 8;
const DEFAULT_CANDIDATE_K = 50;
const DEFAULT_RRF_K = 60;

interface RetrieveRow extends Record<string, unknown> {
  chunk_id: string;
  document_id: string;
  chunk_text: string;
  source_path: string;
  page: number | null;
  score: string | number;
}

/**
 * Escapes Postgres LIKE metacharacters (`\`, `%`, `_`) in a path segment
 * before it's used as a LIKE prefix pattern. Without this, an allowed path
 * that happens to contain a literal `_` (a single-character LIKE wildcard,
 * common in real folder names like "my_folder") would silently widen the
 * match to unrelated paths — a security-relevant boundary bypass.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Builds the WHERE fragment scoping retrieval to `allowedPaths`. A chunk
 * (aliased `c` in the caller's query) qualifies iff its `source_path`
 * equals an allowed path exactly, or sits under an allowed directory. The
 * path separator is appended to the allowed path before prefix-matching so
 * "/data/foo" never matches "/data/foobar/x.pdf" — the same boundary
 * reasoning as ingest.ts's removal pass.
 */
function buildPathFilter(allowedPaths: string[]) {
  const conditions = allowedPaths.map((allowedPath) => {
    const prefix = allowedPath.endsWith(sep) ? allowedPath : allowedPath + sep;
    const likePattern = `${escapeLikePattern(prefix)}%`;
    return sql`(c.source_path = ${allowedPath} OR c.source_path LIKE ${likePattern} ESCAPE '\\')`;
  });
  return sql.join(conditions, sql` OR `);
}

/**
 * Retrieves the top-`k` kb_chunks for `query`, scoped to `orgId` and
 * `allowedPaths`. An empty `allowedPaths` list denies by default and
 * returns `[]` without calling `deps.embed` — an agent granted no paths
 * sees nothing, not "everything."
 */
export async function retrieve(
  orgId: string,
  allowedPaths: string[],
  query: string,
  deps: RetrieveDeps,
  opts: RetrieveOptions = {}
): Promise<RetrievedChunk[]> {
  if (allowedPaths.length === 0) return [];

  const k = opts.k ?? DEFAULT_K;
  const candidateK = opts.candidateK ?? DEFAULT_CANDIDATE_K;
  const rrfK = opts.rrfK ?? DEFAULT_RRF_K;

  const [queryVector] = await deps.embed([query]);
  // pgvector's textual literal is the same `[1,2,3]` form JSON.stringify
  // produces for a number array (see db/vector.ts's customType).
  const queryVectorLiteral = JSON.stringify(queryVector);
  const pathFilter = buildPathFilter(allowedPaths);
  const baseFilter = sql`c.org_id = ${orgId} AND d.status = 'active' AND (${pathFilter})`;

  return db.transaction(async (tx) => {
    // Filtered HNSW recall: without this, pgvector's HNSW index can return
    // fewer than candidateK rows once the WHERE filter (org/status/path)
    // eliminates most of a graph neighborhood, instead of continuing the
    // graph walk until candidateK filtered matches are found. SET LOCAL
    // scopes the setting to this transaction only.
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);

    const rows = await tx.execute<RetrieveRow>(sql`
      WITH vector_arm AS (
        SELECT c.id AS chunk_id,
               ROW_NUMBER() OVER (ORDER BY c.embedding <=> ${queryVectorLiteral}::vector) AS rank
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        WHERE ${baseFilter}
        ORDER BY rank
        LIMIT ${candidateK}
      ),
      fts_arm AS (
        SELECT c.id AS chunk_id,
               ROW_NUMBER() OVER (
                 ORDER BY ts_rank(c.tsv, plainto_tsquery('simple', ${query})) DESC
               ) AS rank
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        WHERE ${baseFilter} AND c.tsv @@ plainto_tsquery('simple', ${query})
        ORDER BY rank
        LIMIT ${candidateK}
      ),
      combined AS (
        SELECT chunk_id, rank FROM vector_arm
        UNION ALL
        SELECT chunk_id, rank FROM fts_arm
      ),
      fused AS (
        SELECT chunk_id, SUM(1.0 / (${rrfK} + rank)) AS score
        FROM combined
        GROUP BY chunk_id
      )
      SELECT c.id AS chunk_id,
             c.document_id AS document_id,
             c.chunk_text AS chunk_text,
             c.source_path AS source_path,
             c.page AS page,
             f.score AS score
      FROM fused f
      JOIN kb_chunks c ON c.id = f.chunk_id
      ORDER BY f.score DESC
      LIMIT ${k}
    `);

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      text: row.chunk_text,
      sourcePath: row.source_path,
      page: row.page,
      score: Number(row.score),
    }));
  });
}

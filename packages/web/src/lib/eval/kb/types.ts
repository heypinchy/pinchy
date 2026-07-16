/**
 * Types for the KB evaluation harness (packages/web/src/lib/eval/kb).
 *
 * Kept decoupled from the invoice-eval taxonomy in `../types` — only
 * `RunResult` and `GraderResult` are reused, since a KB run's shape (queries,
 * retrieved chunks, citations) has nothing to do with an Odoo trajectory, but
 * the pass/tags/notes result envelope and reporting plumbing are shared.
 */

import type { GraderResult, RunResult } from "../types";

/**
 * A retrieved chunk, as the eval sees it. Mirrors `retrieve()`'s return shape
 * in `src/lib/knowledge/retrieve.ts` (which the eval calls directly), NOT the
 * HTTP search route's response body — the route strips `score` and adds
 * `docName`, whereas the eval scores on the fused `score`.
 */
export interface RetrievedChunk {
  chunkId: string;
  sourcePath: string;
  page: number | null;
  text: string;
  /** Fused RRF score, higher = better. */
  score: number;
}

/** One gold retrieval expectation: a query and the chunk ids that MUST be retrieved. */
export interface GoldQuery {
  id: string;
  /** DE or EN — the design promises cross-lingual retrieval; both are represented. */
  lang: "de" | "en";
  query: string;
  /** Chunk ids (stable, corpus-authored) that are relevant. Order = ideal rank for nDCG. */
  relevantChunkIds: string[];
  /**
   * Behavioral axis this query exercises, for per-axis scorecard slicing:
   * path-citation | dedup | multi-hop | distractor | cross-lingual | happy.
   */
  axis: KbEvalAxis;
}

export type KbEvalAxis =
  "happy" | "path-citation" | "dedup" | "multi-hop" | "distractor" | "cross-lingual";

/** A gold Q/A item for Layer 3 (groundedness). Extends GoldQuery with an answer key. */
export interface GoldQA extends GoldQuery {
  /** A reference answer (for answer-relevance). Not string-matched — judged. */
  referenceAnswer: string;
  /** If the corpus genuinely cannot answer this, the correct behavior is abstention. */
  expectAbstention?: boolean;
}

/** KB-specific failure taxonomy (kept separate from the invoice FailureTag union). */
export type KbFailureTag =
  | "recall-miss" // an expected chunk was not retrieved
  | "dedup-inflation" // near-duplicate chunks counted as independent sources
  | "path-not-cited" // citation used a bare filename, not the full path
  | "citation-unresolved" // an inline [N] has no Sources entry (cited-but-unlisted)
  | "source-uncited" // a Sources entry was never cited inline (listed-but-uncited)
  | "sources-format" // Sources list not rendered as markdown bullets
  | "ungrounded-claim" // an answer sentence not entailed by any cited passage
  | "off-topic-grounded" // grounded but does not answer the question (relevance fail)
  | "false-abstention" // abstained though the corpus contained the answer
  | "missed-abstention"; // answered though the corpus could not support it

export interface KbGraderResult extends Omit<GraderResult, "tags"> {
  tags: KbFailureTag[];
}

export type { RunResult };

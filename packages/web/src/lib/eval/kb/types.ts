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

/**
 * The single source of truth for the KB eval axes as a runtime-iterable list
 * (the `KbEvalAxis` union above is compile-time only). Consumers that need to
 * loop over every axis — the Layer-1 scorecard's per-axis breakdown, per-axis
 * gate assertions — import THIS rather than re-declaring their own array, so a
 * new axis is added in exactly one place.
 *
 * `satisfies readonly KbEvalAxis[]` rejects a typo'd/removed member, and the
 * `_Exhaustive` sentinel below rejects the other direction: if `KbEvalAxis`
 * grows a member that is NOT listed here, `Exclude<...>` is a non-`never`
 * union, so the conditional resolves to `never` and the `true` assignment is a
 * compile error. (Verified by temporarily adding a fake union member — it
 * errors — during review of the KB eval gate.)
 */
export const KB_EVAL_AXES = [
  "happy",
  "path-citation",
  "dedup",
  "multi-hop",
  "distractor",
  "cross-lingual",
] as const satisfies readonly KbEvalAxis[];

type _Exhaustive = Exclude<KbEvalAxis, (typeof KB_EVAL_AXES)[number]> extends never ? true : never;
// Instantiated so the compile-time check is not dead code: if a KbEvalAxis
// member is missing from KB_EVAL_AXES, `_Exhaustive` is `never` and this
// `true` assignment fails to typecheck.
const _exhaustiveCheck: _Exhaustive = true;
void _exhaustiveCheck;

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
  | "missed-abstention" // answered though the corpus could not support it
  // A run-level infra failure (dispatch idle-timeout, raw-text capture error,
  // any harness/transport error) — NOT a model-quality signal. The sweep
  // records it so a hung/broken run becomes a data point instead of crashing,
  // but the scorecard exporter EXCLUDES these from a cell's n (they are
  // neither passes nor model failures), mirroring the invoice harness's
  // identical `run-infra-error` exclusion in `../export-scorecard.ts`.
  | "run-infra-error";

export interface KbGraderResult extends Omit<GraderResult, "tags"> {
  tags: KbFailureTag[];
}

export type { RunResult };

/**
 * Pure retrieval-quality scoring for the KB eval harness's Layer-1 gate.
 * No DB import here — the caller supplies a `retrievalFn` that resolves a
 * `GoldQuery` to a ranked list of chunk ids however it likes (a real DB call
 * in the integration test, a canned array in unit tests). This module only
 * scores those rankings against `metrics.ts` and averages them.
 */
import { ndcgAtK, reciprocalRank, recallAtK } from "./metrics";
import { KB_EVAL_AXES } from "./types";
import type { GoldQuery, KbEvalAxis } from "./types";

const K = 10;

export interface PerQueryScore {
  queryId: string;
  axis: KbEvalAxis;
  recallAt10: number;
  reciprocalRank: number;
  ndcgAt10: number;
  retrievedChunkIds: string[];
}

export interface AxisScore {
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  n: number;
}

export interface AggregateScore {
  /** Mean recall@10 over all queries. */
  recallAt10: number;
  /** Mean reciprocal rank over all queries. */
  mrr: number;
  /** Mean nDCG@10 over all queries. */
  ndcgAt10: number;
  perAxis: Record<KbEvalAxis, AxisScore>;
  n: number;
}

/**
 * Runs `retrievalFn` for every gold query, in order, and scores each result
 * against that query's `relevantChunkIds` using recall@10 / RR / nDCG@10.
 */
export async function runRetrievalEval(
  goldQueries: GoldQuery[],
  retrievalFn: (q: GoldQuery) => Promise<string[]>
): Promise<PerQueryScore[]> {
  const scores: PerQueryScore[] = [];
  for (const q of goldQueries) {
    const retrievedChunkIds = await retrievalFn(q);
    scores.push({
      queryId: q.id,
      axis: q.axis,
      recallAt10: recallAtK(retrievedChunkIds, q.relevantChunkIds, K),
      reciprocalRank: reciprocalRank(retrievedChunkIds, q.relevantChunkIds),
      ndcgAt10: ndcgAtK(retrievedChunkIds, q.relevantChunkIds, K),
      retrievedChunkIds,
    });
  }
  return scores;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarize(scores: PerQueryScore[]): { recallAt10: number; mrr: number; ndcgAt10: number } {
  return {
    recallAt10: mean(scores.map((s) => s.recallAt10)),
    mrr: mean(scores.map((s) => s.reciprocalRank)),
    ndcgAt10: mean(scores.map((s) => s.ndcgAt10)),
  };
}

/** Minimal shape `nearDuplicateSourcePaths` needs — deliberately not `RetrievedChunk` from `../../knowledge/retrieve`, to keep this pure scoring module DB-import-free (see file header). */
export interface SourcePathChunk {
  chunkId: string;
  sourcePath: string;
}

/**
 * Dedup-axis TELEMETRY, not a gate: returns the distinct `sourcePath`s, in
 * order of first appearance, among `retrieved` entries whose `chunkId` is in
 * `forChunkIds`.
 *
 * This exists to make the near-duplicate rate in retrieved chunks visible
 * (how many distinct source paths carry a shared/reworded passage), NOT to
 * assert a collapse ceiling. `kb_documents` are keyed by
 * `(org_id, source_path)` (see `db/schema.ts`'s `uq_kb_doc_org_path`
 * comment), so retrieval deliberately keeps near-duplicate passages from
 * different paths independently retrievable — collapsing them would break
 * per-path `allowed_paths` access-control scoping. The
 * "don't let a reworded duplicate look like independent corroboration"
 * concern belongs to the attribution layer (Layer 2, unique-docs-per-answer
 * on what the LLM actually cites), not to retrieval. See the "dedup axis"
 * describe block in `kb-retrieval-eval.integration.test.ts` for the full
 * rationale and the gate this function feeds.
 */
export function nearDuplicateSourcePaths(
  retrieved: SourcePathChunk[],
  forChunkIds: string[]
): string[] {
  const wanted = new Set(forChunkIds);
  const seen = new Set<string>();
  const distinctPaths: string[] = [];
  for (const chunk of retrieved) {
    if (!wanted.has(chunk.chunkId) || seen.has(chunk.sourcePath)) continue;
    seen.add(chunk.sourcePath);
    distinctPaths.push(chunk.sourcePath);
  }
  return distinctPaths;
}

/**
 * Aggregates per-query scores into overall means plus a per-axis breakdown.
 * An axis with no queries reports `n: 0` and all-zero scores rather than
 * NaN (0/0), and is omitted from the overall means' denominator by simply
 * not contributing any scores.
 */
export function aggregate(scores: PerQueryScore[]): AggregateScore {
  // Reduce over KB_EVAL_AXES so the Record is complete by construction — no
  // `{} as Record<KbEvalAxis, AxisScore>` cast that would silently tolerate a
  // missing axis if the union grew.
  const perAxis = KB_EVAL_AXES.reduce(
    (acc, axis) => {
      const axisScores = scores.filter((s) => s.axis === axis);
      acc[axis] = { ...summarize(axisScores), n: axisScores.length };
      return acc;
    },
    {} as Record<KbEvalAxis, AxisScore>
  );

  return {
    ...summarize(scores),
    perAxis,
    n: scores.length,
  };
}

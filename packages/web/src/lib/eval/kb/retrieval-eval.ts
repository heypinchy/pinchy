/**
 * Pure retrieval-quality scoring for the KB eval harness's Layer-1 gate.
 * No DB import here — the caller supplies a `retrievalFn` that resolves a
 * `GoldQuery` to a ranked list of chunk ids however it likes (a real DB call
 * in the integration test, a canned array in unit tests). This module only
 * scores those rankings against `metrics.ts` and averages them.
 */
import { ndcgAtK, reciprocalRank, recallAtK } from "./metrics";
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

const ALL_AXES: KbEvalAxis[] = [
  "happy",
  "path-citation",
  "dedup",
  "multi-hop",
  "distractor",
  "cross-lingual",
];

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

/**
 * Aggregates per-query scores into overall means plus a per-axis breakdown.
 * An axis with no queries reports `n: 0` and all-zero scores rather than
 * NaN (0/0), and is omitted from the overall means' denominator by simply
 * not contributing any scores.
 */
export function aggregate(scores: PerQueryScore[]): AggregateScore {
  const perAxis = {} as Record<KbEvalAxis, AxisScore>;
  for (const axis of ALL_AXES) {
    const axisScores = scores.filter((s) => s.axis === axis);
    perAxis[axis] = { ...summarize(axisScores), n: axisScores.length };
  }

  return {
    ...summarize(scores),
    perAxis,
    n: scores.length,
  };
}

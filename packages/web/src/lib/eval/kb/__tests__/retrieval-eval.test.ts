import { describe, expect, it } from "vitest";

import { aggregate, runRetrievalEval } from "../retrieval-eval";
import type { GoldQuery } from "../types";

function gq(id: string, axis: GoldQuery["axis"], relevantChunkIds: string[]): GoldQuery {
  return { id, lang: "en", query: `query for ${id}`, relevantChunkIds, axis };
}

describe("runRetrievalEval", () => {
  it("scores each query's retrievalFn output against its relevantChunkIds", async () => {
    const queries: GoldQuery[] = [gq("q1", "happy", ["a"]), gq("q2", "dedup", ["x", "y"])];
    const retrievalFn = async (q: GoldQuery): Promise<string[]> => {
      if (q.id === "q1") return ["a", "b", "c"];
      return ["z", "y", "x"];
    };

    const scores = await runRetrievalEval(queries, retrievalFn);

    expect(scores).toHaveLength(2);
    expect(scores[0]).toMatchObject({
      queryId: "q1",
      axis: "happy",
      recallAt10: 1,
      reciprocalRank: 1,
      retrievedChunkIds: ["a", "b", "c"],
    });
    // "x" and "y" both relevant; "y" ranked 2nd, "x" ranked 3rd → recall 1, RR = 1/2.
    expect(scores[1]).toMatchObject({
      queryId: "q2",
      axis: "dedup",
      recallAt10: 1,
      reciprocalRank: 0.5,
      retrievedChunkIds: ["z", "y", "x"],
    });
  });

  it("calls retrievalFn once per query, in order", async () => {
    const calls: string[] = [];
    const queries: GoldQuery[] = [gq("q1", "happy", ["a"]), gq("q2", "happy", ["b"])];
    await runRetrievalEval(queries, async (q) => {
      calls.push(q.id);
      return [];
    });
    expect(calls).toEqual(["q1", "q2"]);
  });
});

describe("aggregate", () => {
  it("computes overall means and per-axis means", () => {
    const scores = [
      {
        queryId: "q1",
        axis: "happy" as const,
        recallAt10: 1,
        reciprocalRank: 1,
        ndcgAt10: 1,
        retrievedChunkIds: ["a"],
      },
      {
        queryId: "q2",
        axis: "happy" as const,
        recallAt10: 0.5,
        reciprocalRank: 0.5,
        ndcgAt10: 0.5,
        retrievedChunkIds: ["b"],
      },
      {
        queryId: "q3",
        axis: "dedup" as const,
        recallAt10: 0,
        reciprocalRank: 0,
        ndcgAt10: 0,
        retrievedChunkIds: [],
      },
    ];

    const agg = aggregate(scores);

    expect(agg.n).toBe(3);
    expect(agg.recallAt10).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(agg.mrr).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(agg.ndcgAt10).toBeCloseTo((1 + 0.5 + 0) / 3);

    expect(agg.perAxis.happy).toEqual({
      recallAt10: 0.75,
      mrr: 0.75,
      ndcgAt10: 0.75,
      n: 2,
    });
    expect(agg.perAxis.dedup).toEqual({ recallAt10: 0, mrr: 0, ndcgAt10: 0, n: 1 });
  });

  it("gives an axis with no queries n:0 and 0 scores rather than NaN", () => {
    const agg = aggregate([]);
    expect(agg.n).toBe(0);
    expect(agg.recallAt10).toBe(0);
    expect(agg.mrr).toBe(0);
    expect(agg.ndcgAt10).toBe(0);
    for (const axis of Object.values(agg.perAxis)) {
      expect(axis).toEqual({ recallAt10: 0, mrr: 0, ndcgAt10: 0, n: 0 });
    }
  });
});

import { describe, expect, it } from "vitest";
import { ndcgAtK, reciprocalRank, recallAtK } from "../metrics";

describe("recallAtK", () => {
  it("recall@k = fraction of relevant ids present in the top-k retrieved", () => {
    expect(recallAtK(["a", "b", "c", "d"], ["b", "d", "z"], 4)).toBeCloseTo(2 / 3);
    expect(recallAtK([], ["a"], 5)).toBe(0);
    expect(recallAtK(["a"], [], 5)).toBe(1); // no relevant → vacuously 1 (gold-set guarantees ≥1 in practice)
  });

  it("only counts hits within the top-k slice, not the full retrieved list", () => {
    // "b" is relevant but ranked 3rd; k=2 excludes it.
    expect(recallAtK(["a", "x", "b"], ["a", "b"], 2)).toBeCloseTo(1 / 2);
  });

  it("returns 0 for k=0 (empty top slice)", () => {
    expect(recallAtK(["a", "b"], ["a"], 0)).toBe(0);
  });

  it("clamps k larger than the retrieved array to the array length", () => {
    expect(recallAtK(["a"], ["a", "b"], 100)).toBeCloseTo(1 / 2);
  });
});

describe("reciprocalRank", () => {
  it("reciprocalRank = 1/(rank of first relevant), 0 if none in list", () => {
    expect(reciprocalRank(["x", "b", "c"], ["b"])).toBeCloseTo(1 / 2);
    expect(reciprocalRank(["x", "y"], ["b"])).toBe(0);
  });

  it("uses the FIRST matching rank when multiple relevant ids are retrieved", () => {
    expect(reciprocalRank(["x", "b", "d"], ["d", "b"])).toBeCloseTo(1 / 2);
  });

  it("returns 1 when the first retrieved id is relevant", () => {
    expect(reciprocalRank(["b", "x"], ["b"])).toBe(1);
  });

  it("returns 0 for an empty retrieved list", () => {
    expect(reciprocalRank([], ["b"])).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("nDCG@k rewards ranking relevant chunks higher", () => {
    const good = ndcgAtK(["a", "b", "x"], ["a", "b"], 3);
    const bad = ndcgAtK(["x", "a", "b"], ["a", "b"], 3);
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeCloseTo(1); // perfect ordering
  });

  it("returns 0 when relevant is empty (IDCG is 0)", () => {
    expect(ndcgAtK(["a", "b"], [], 2)).toBe(0);
  });

  it("does not count a relevant item ranked beyond k", () => {
    // "b" is relevant but at rank 3 (index 2); k=2 excludes it, leaving only
    // "a" as a hit, so DCG < IDCG for the 2 relevant ids and nDCG < 1.
    const ndcg = ndcgAtK(["a", "x", "b"], ["a", "b"], 2);
    const dcg = 1 / Math.log2(2); // only "a" hits within top-2
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3); // ideal: 2 hits ranked first
    expect(ndcg).toBeCloseTo(dcg / idcg);
  });

  it("returns 0 for k=0 (empty top slice)", () => {
    expect(ndcgAtK(["a", "b"], ["a"], 0)).toBe(0);
  });

  it("hand-checked value for the perfect-ordering case", () => {
    // rel = [1, 1, 0] → DCG = 1/log2(2) + 1/log2(3) = 1 + 0.6309...
    // IDCG uses the same 2 ideal hits ranked first, so DCG === IDCG → nDCG = 1.
    const dcg = 1 / Math.log2(2) + 1 / Math.log2(3);
    expect(dcg).toBeCloseTo(1.6309, 3);
    expect(ndcgAtK(["a", "b", "x"], ["a", "b"], 3)).toBeCloseTo(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  pooledClusteredDifference,
  scenarioDifference,
  tiedWithLeader,
  type ComparableCell,
} from "../comparisons";

const cell = (model: string, passes: number, n = 12): ComparableCell => ({ model, passes, n });

describe("scenarioDifference (Newcombe hybrid-score interval)", () => {
  it("separates a perfect model from a hopeless one", () => {
    const d = scenarioDifference(cell("a", 12), cell("b", 0));
    expect(d.diff).toBe(1);
    expect(d.ci[0]).toBeGreaterThan(0);
    expect(d.tied).toBe(false);
  });

  it("calls two identical cells tied, with a zero difference", () => {
    const d = scenarioDifference(cell("a", 6), cell("b", 6));
    expect(d.diff).toBe(0);
    expect(d.ci[0]).toBeLessThan(0);
    expect(d.ci[1]).toBeGreaterThan(0);
    expect(d.tied).toBe(true);
  });

  it("calls a one-run gap at n=12 a tie — the honest read at this sample size", () => {
    const d = scenarioDifference(cell("a", 7), cell("b", 6));
    expect(d.tied).toBe(true);
  });

  it("is antisymmetric in its arguments", () => {
    const ab = scenarioDifference(cell("a", 9), cell("b", 4));
    const ba = scenarioDifference(cell("b", 4), cell("a", 9));
    expect(ba.diff).toBeCloseTo(-ab.diff, 10);
    expect(ba.tied).toBe(ab.tied);
  });

  it("never produces a Wald-style interval that escapes [-1, 1] at the boundary", () => {
    const d = scenarioDifference(cell("a", 12), cell("b", 12));
    expect(d.ci[0]).toBeGreaterThanOrEqual(-1);
    expect(d.ci[1]).toBeLessThanOrEqual(1);
    expect(d.tied).toBe(true);
  });
});

describe("tiedWithLeader", () => {
  it("includes every model the leader is not significantly ahead of", () => {
    const tied = tiedWithLeader([cell("lead", 12), cell("close", 11), cell("hopeless", 0)]);
    expect(tied).toContain("lead");
    expect(tied).toContain("close");
    expect(tied).not.toContain("hopeless");
  });

  it("returns just the leader when everyone else is clearly behind", () => {
    expect(tiedWithLeader([cell("lead", 12), cell("bad", 0), cell("worse", 0)])).toEqual(["lead"]);
  });

  it("returns an empty list for no cells", () => {
    expect(tiedWithLeader([])).toEqual([]);
  });
});

describe("pooledClusteredDifference", () => {
  it("averages the per-scenario differences", () => {
    const pooled = pooledClusteredDifference([
      { a: cell("a", 12), b: cell("b", 6) },
      { a: cell("a", 6), b: cell("b", 0) },
    ]);
    // per-scenario diffs are 0.5 and 0.5 -> mean 0.5
    expect(pooled.diff).toBeCloseTo(0.5, 10);
    expect(pooled.scenarios).toBe(2);
  });

  it("widens the interval when the per-scenario differences disagree", () => {
    const consistent = pooledClusteredDifference([
      { a: cell("a", 9), b: cell("b", 6) },
      { a: cell("a", 9), b: cell("b", 6) },
      { a: cell("a", 9), b: cell("b", 6) },
    ]);
    const scattered = pooledClusteredDifference([
      { a: cell("a", 12), b: cell("b", 0) },
      { a: cell("a", 0), b: cell("b", 12) },
      { a: cell("a", 9), b: cell("b", 6) },
    ]);
    const width = (p: { ci: [number, number] }) => p.ci[1] - p.ci[0];
    expect(width(scattered)).toBeGreaterThan(width(consistent));
    expect(scattered.tied).toBe(true);
  });

  it("reports a tie when the clustered interval spans zero", () => {
    const pooled = pooledClusteredDifference([
      { a: cell("a", 6), b: cell("b", 6) },
      { a: cell("a", 7), b: cell("b", 6) },
    ]);
    expect(pooled.tied).toBe(true);
  });

  it("has no interval to report for a single scenario (no between-cluster spread)", () => {
    const pooled = pooledClusteredDifference([{ a: cell("a", 12), b: cell("b", 0) }]);
    expect(pooled.scenarios).toBe(1);
    expect(pooled.tied).toBe(true);
  });

  it("returns a zero-scenario result for an empty pair list", () => {
    const pooled = pooledClusteredDifference([]);
    expect(pooled.scenarios).toBe(0);
    expect(pooled.tied).toBe(true);
  });
});

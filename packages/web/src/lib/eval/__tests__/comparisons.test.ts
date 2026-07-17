import { describe, expect, it } from "vitest";
import {
  pooledClusteredDifference,
  scenarioDifference,
  tiedWithLeader,
  type ComparableCell,
} from "../comparisons";

const cell = (model: string, passes: number, n = 12): ComparableCell => ({ model, passes, n });
const width = (p: { ci: [number, number] }): number => p.ci[1] - p.ci[0];

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

  it("keeps a model with no valid trials in the tie set", () => {
    // A cell whose every run was an excluded infra error (n=0) has produced no
    // evidence, so nothing rules it out of the lead. Treating its missing rate
    // as 0% would exclude it — a claim from zero data.
    const tied = tiedWithLeader([cell("lead", 12), cell("nodata", 0, 0), cell("hopeless", 0)]);
    expect(tied).toContain("nodata");
    expect(tied).not.toContain("hopeless");
  });

  it("does not let a zero-trial cell become the leader", () => {
    const tied = tiedWithLeader([cell("nodata", 0, 0), cell("real", 12), cell("hopeless", 0)]);
    expect(tied).toContain("real");
    expect(tied).not.toContain("hopeless");
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
    expect(width(scattered)).toBeGreaterThan(width(consistent));
    expect(scattered.tied).toBe(true);
    // Ordering alone is a vacuous assertion if `consistent` collapses to width
    // 0 — which is exactly what it used to do. Pin the floor too.
    expect(width(consistent)).toBeGreaterThan(0.1);
  });

  it("keeps a real interval when every scenario reports the SAME difference", () => {
    // Identical per-scenario diffs mean zero BETWEEN-scenario spread. An SE
    // taken only from that spread is 0, and the interval collapses to a point
    // — infinite confidence from 36 runs. The within-scenario binomial error
    // is still there and must hold the interval open.
    const pooled = pooledClusteredDifference([
      { a: cell("a", 9), b: cell("b", 6) },
      { a: cell("a", 9), b: cell("b", 6) },
      { a: cell("a", 9), b: cell("b", 6) },
    ]);
    expect(pooled.se).toBeGreaterThan(0);
    expect(width(pooled)).toBeGreaterThan(0.1);
  });

  it("agrees with the per-scenario read: a one-run gap stays a tie when pooled", () => {
    // scenarioDifference calls 12/12 vs 11/12 a tie (see above). Seven
    // scenarios of that same one-run gap is not new evidence of a winner — it
    // is the same weak signal seven times. The pooled verdict must not
    // contradict the per-scenario one.
    const pairs = Array.from({ length: 7 }, () => ({ a: cell("a", 12), b: cell("b", 11) }));
    expect(scenarioDifference(cell("a", 12), cell("b", 11)).tied).toBe(true);
    expect(pooledClusteredDifference(pairs).tied).toBe(true);
  });

  it("never reports a narrower interval than treating every run as independent", () => {
    // Clustering exists because runs within a scenario are NOT independent, so
    // it must cost precision, never buy it. If the clustered interval is
    // narrower than the (already anti-conservative) full-independence bound on
    // the same evidence, the SE has lost the within-scenario error term.
    const perScenario = [
      [12, 11],
      [12, 11],
      [12, 11],
      [12, 11],
      [12, 11],
      [12, 11],
      [12, 10],
    ];
    const clustered = pooledClusteredDifference(
      perScenario.map(([a, b]) => ({ a: cell("a", a), b: cell("b", b) }))
    );
    const independent = scenarioDifference(
      cell(
        "a",
        perScenario.reduce((s, [a]) => s + a, 0),
        84
      ),
      cell(
        "b",
        perScenario.reduce((s, [, b]) => s + b, 0),
        84
      )
    );
    expect(width(clustered)).toBeGreaterThanOrEqual(width(independent));
  });

  it("ignores scenarios where either model has no valid trials", () => {
    // n=0 (every run an excluded infra error) is absence of evidence. Counting
    // it as a 0% pass rate would invent a difference out of nothing.
    const withDeadScenario = pooledClusteredDifference([
      { a: cell("a", 9), b: cell("b", 6) },
      { a: cell("a", 9), b: cell("b", 6) },
      { a: cell("a", 0, 0), b: cell("b", 6) },
    ]);
    expect(withDeadScenario.scenarios).toBe(2);
    expect(withDeadScenario.diff).toBeCloseTo(0.25, 10);
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

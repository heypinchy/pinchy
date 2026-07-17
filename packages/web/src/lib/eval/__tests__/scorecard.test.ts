import { describe, expect, it } from "vitest";
import {
  buildScorecard,
  computePassCaretK,
  computePassHatK,
  passHatKCurve,
  wilsonInterval,
} from "../scorecard";
import type { RunResult } from "../types";

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    model: "model-a",
    passed: true,
    tags: [],
    notes: [],
    latencyMs: 1000,
    ...overrides,
  };
}

describe("wilsonInterval", () => {
  it("matches known value for 8/10 at z=1.96", () => {
    const [lower, upper] = wilsonInterval(8, 10, 1.96);
    expect(lower).toBeCloseTo(0.49, 2);
    expect(upper).toBeCloseTo(0.943, 3);
  });

  it("lower bound is 0 for 0/5", () => {
    const [lower, upper] = wilsonInterval(0, 5, 1.96);
    expect(lower).toBe(0);
    expect(upper).toBeGreaterThan(0);
    expect(upper).toBeLessThanOrEqual(1);
  });

  it("upper bound is 1 for 5/5", () => {
    const [lower, upper] = wilsonInterval(5, 5, 1.96);
    expect(upper).toBe(1);
    expect(lower).toBeLessThan(1);
    expect(lower).toBeGreaterThanOrEqual(0);
  });

  it("returns the uninformative [0, 1] for n=0, not a point mass at 0", () => {
    // Zero trials means "we know nothing", not "it fails every time". The
    // point-mass [0, 0] this used to return reads as CERTAINTY that the model
    // scores 0, which is how a cell whose every run was an invalid trial
    // (`run-infra-error`, excluded from n) got declared significantly worse
    // than the leader in `comparisons.ts` — from no data at all.
    const [lower, upper] = wilsonInterval(0, 0, 1.96);
    expect(lower).toBe(0);
    expect(upper).toBe(1);
  });

  it("clamps into [0, 1]", () => {
    const [lower, upper] = wilsonInterval(3, 3, 1.96);
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThanOrEqual(1);
  });
});

describe("buildScorecard", () => {
  it("groups by model and computes pass rate", () => {
    const runs: RunResult[] = [
      run({ model: "model-a", passed: true }),
      run({ model: "model-a", passed: true }),
      run({ model: "model-a", passed: false, tags: ["task-incomplete"] }),
      run({ model: "model-b", passed: false, tags: ["false-success"] }),
    ];
    const scorecard = buildScorecard(runs);
    const a = scorecard.find((e) => e.model === "model-a");
    const b = scorecard.find((e) => e.model === "model-b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.n).toBe(3);
    expect(a!.passes).toBe(2);
    expect(a!.passRate).toBeCloseTo(2 / 3, 5);
    expect(b!.n).toBe(1);
    expect(b!.passes).toBe(0);
    expect(b!.passRate).toBe(0);
  });

  it("builds a tag histogram counting each tag across runs", () => {
    const runs: RunResult[] = [
      run({ model: "model-a", passed: false, tags: ["task-incomplete", "false-success"] }),
      run({ model: "model-a", passed: false, tags: ["task-incomplete"] }),
      run({ model: "model-a", passed: true, tags: [] }),
    ];
    const scorecard = buildScorecard(runs);
    const a = scorecard.find((e) => e.model === "model-a")!;
    expect(a.tagHistogram["task-incomplete"]).toBe(2);
    expect(a.tagHistogram["false-success"]).toBe(1);
    expect(a.tagHistogram["id-malformed"]).toBeUndefined();
  });

  it("computes median latency", () => {
    const runs: RunResult[] = [
      run({ model: "model-a", latencyMs: 100 }),
      run({ model: "model-a", latencyMs: 300 }),
      run({ model: "model-a", latencyMs: 200 }),
    ];
    const scorecard = buildScorecard(runs);
    const a = scorecard.find((e) => e.model === "model-a")!;
    expect(a.medianLatencyMs).toBe(200);
  });

  it("computes median total tokens when tokens are present", () => {
    const runs: RunResult[] = [
      run({ model: "model-a", tokens: { prompt: 100, completion: 50 } }), // 150
      run({ model: "model-a", tokens: { prompt: 200, completion: 100 } }), // 300
      run({ model: "model-a", tokens: { prompt: 50, completion: 50 } }), // 100
    ];
    const scorecard = buildScorecard(runs);
    const a = scorecard.find((e) => e.model === "model-a")!;
    expect(a.medianTokens).toBe(150);
  });

  it("leaves medianTokens undefined when no runs have token data", () => {
    const runs: RunResult[] = [run({ model: "model-a" }), run({ model: "model-a" })];
    const scorecard = buildScorecard(runs);
    const a = scorecard.find((e) => e.model === "model-a")!;
    expect(a.medianTokens).toBeUndefined();
  });

  it("computes a Wilson 95% interval for each model", () => {
    const runs: RunResult[] = [
      run({ model: "model-a", passed: true }),
      run({ model: "model-a", passed: true }),
      run({ model: "model-a", passed: false }),
    ];
    const scorecard = buildScorecard(runs);
    const a = scorecard.find((e) => e.model === "model-a")!;
    const [lower, upper] = a.wilson95;
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThanOrEqual(1);
    expect(lower).toBeLessThanOrEqual(a.passRate);
    expect(upper).toBeGreaterThanOrEqual(a.passRate);
  });

  it("sorts entries by passRate descending", () => {
    const runs: RunResult[] = [
      run({ model: "model-low", passed: false }),
      run({ model: "model-high", passed: true }),
      run({ model: "model-mid", passed: true }),
      run({ model: "model-mid", passed: false }),
    ];
    const scorecard = buildScorecard(runs);
    expect(scorecard.map((e) => e.model)).toEqual(["model-high", "model-mid", "model-low"]);
  });

  it("returns an empty array for no runs", () => {
    expect(buildScorecard([])).toEqual([]);
  });

  describe("passCaretK (all-k consistency, via buildScorecard)", () => {
    it("is 1 when every run for the model passed", () => {
      const runs: RunResult[] = [
        run({ model: "model-a", passed: true }),
        run({ model: "model-a", passed: true }),
        run({ model: "model-a", passed: true }),
      ];
      const scorecard = buildScorecard(runs);
      const a = scorecard.find((e) => e.model === "model-a")!;
      expect(a.passCaretK).toBe(1);
    });

    it("is 0 when any run for the model failed", () => {
      const runs: RunResult[] = [
        run({ model: "model-a", passed: true }),
        run({ model: "model-a", passed: true }),
        run({ model: "model-a", passed: false }),
      ];
      const scorecard = buildScorecard(runs);
      const a = scorecard.find((e) => e.model === "model-a")!;
      expect(a.passCaretK).toBe(0);
    });

    it("a single passing run also yields passCaretK 1 (k=1 degenerate case)", () => {
      const runs: RunResult[] = [run({ model: "model-a", passed: true })];
      const scorecard = buildScorecard(runs);
      const a = scorecard.find((e) => e.model === "model-a")!;
      expect(a.passCaretK).toBe(1);
      expect(a.passRate).toBe(1);
    });
  });
});

describe("computePassCaretK (pure helper)", () => {
  it("is 1 when all n runs passed", () => {
    expect(computePassCaretK([run({ passed: true }), run({ passed: true })])).toBe(1);
  });

  it("is 0 when any run failed", () => {
    expect(computePassCaretK([run({ passed: true }), run({ passed: false })])).toBe(0);
  });

  it("is 0 for n=0 (no trials, no proven consistency)", () => {
    expect(computePassCaretK([])).toBe(0);
  });
});

describe("buildScorecard<Tag> generic boundary", () => {
  // Proves buildScorecard/computePassCaretK genuinely work with a
  // NON-invoice tag union with no cast — the type boundary a non-invoice
  // caller (e.g. the KB eval harness) relies on. Uses a synthetic tag union
  // here to prove the mechanism in isolation, decoupled from KbFailureTag's
  // vocabulary; the KB harness itself is exercised end-to-end in
  // groundedness-pipeline.test.ts.
  type CustomTag = "custom-a" | "custom-b";

  function customRun(overrides: Partial<RunResult<CustomTag>> = {}): RunResult<CustomTag> {
    return {
      model: "model-a",
      passed: true,
      tags: [],
      notes: [],
      latencyMs: 1000,
      ...overrides,
    };
  }

  it("groups and grades runs typed on a custom tag union with no cast", () => {
    const runs: RunResult<CustomTag>[] = [
      customRun({ passed: true }),
      customRun({ passed: false, tags: ["custom-a"] }),
      customRun({ passed: false, tags: ["custom-a", "custom-b"] }),
    ];

    const scorecard = buildScorecard<CustomTag>(runs);
    const a = scorecard.find((e) => e.model === "model-a")!;

    expect(a.n).toBe(3);
    expect(a.passes).toBe(1);
    expect(a.tagHistogram["custom-a"]).toBe(2);
    expect(a.tagHistogram["custom-b"]).toBe(1);
    expect(a.passCaretK).toBe(0);
    expect(computePassCaretK<CustomTag>(runs)).toBe(0);
  });
});

describe("computePassHatK (unbiased pass^k, τ-bench estimator)", () => {
  it("is 1 at any k when every run passed", () => {
    expect(computePassHatK(12, 12, 8)).toBe(1);
    expect(computePassHatK(12, 12, 12)).toBe(1);
  });

  it("equals the pass rate at k=1", () => {
    expect(computePassHatK(7, 10, 1)).toBeCloseTo(0.7, 10);
    expect(computePassHatK(6, 12, 1)).toBeCloseTo(0.5, 10);
  });

  it("matches C(c,k)/C(n,k) for a partial cell", () => {
    // 6 of 12 passed, k=2: C(6,2)/C(12,2) = 15/66.
    expect(computePassHatK(6, 12, 2)).toBeCloseTo(15 / 66, 10);
    // 9 of 12 passed, k=8: C(9,8)/C(12,8) = 9/495.
    expect(computePassHatK(9, 12, 8)).toBeCloseTo(9 / 495, 10);
  });

  it("is 0 when fewer than k runs passed (an all-k subset is impossible)", () => {
    expect(computePassHatK(5, 12, 8)).toBe(0);
    expect(computePassHatK(0, 12, 2)).toBe(0);
  });

  it("is 1 at k=0 and 0 for n=0", () => {
    expect(computePassHatK(3, 12, 0)).toBe(1);
    expect(computePassHatK(0, 0, 2)).toBe(0);
  });
});

describe("passHatKCurve", () => {
  it("reports every standard k for a full-N cell, all at 1", () => {
    expect(passHatKCurve(12, 12)).toEqual([
      { k: 1, value: 1 },
      { k: 2, value: 1 },
      { k: 4, value: 1 },
      { k: 8, value: 1 },
      { k: 12, value: 1 },
    ]);
  });

  it("drops k levels above the cell's n", () => {
    // n=8: k=12 is undefined (can't draw 12 from 8) and is omitted.
    expect(passHatKCurve(8, 8).map((p) => p.k)).toEqual([1, 2, 4, 8]);
  });

  it("rounds values to 3 decimals, showing the reliability decay", () => {
    const curve = passHatKCurve(6, 12);
    expect(curve.find((p) => p.k === 1)?.value).toBe(0.5);
    expect(curve.find((p) => p.k === 2)?.value).toBe(Number((15 / 66).toFixed(3)));
    expect(curve.find((p) => p.k === 4)?.value).toBe(Number((15 / 495).toFixed(3)));
    // Only 6 of 12 passed, so an 8-of-8 all-pass subset is impossible: pass^8 = 0.
    expect(curve.find((p) => p.k === 8)?.value).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { buildScorecard, wilsonInterval } from "../scorecard";
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

  it("returns [0, 0] for n=0", () => {
    const [lower, upper] = wilsonInterval(0, 0, 1.96);
    expect(lower).toBe(0);
    expect(upper).toBe(0);
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
});

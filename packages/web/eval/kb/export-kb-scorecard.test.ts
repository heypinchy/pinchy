// packages/web/eval/kb/export-kb-scorecard.test.ts
//
// Unit test of the AGGREGATION SHAPE only — `aggregateKbResults` is a pure
// function over hand-built `KbRunResultRow[]` fixtures, no filesystem I/O
// (that's `main()`'s job, exercised by running the script for real, not by
// this test). Mirrors the fact that `eval/export-scorecard.ts` (the invoice
// twin) has no unit coverage today; this is the KB harness's read-side
// insurance that the per-axis/per-model consolidation shape is right before
// it ever gets wired to real Task 3.4 output.
import { describe, expect, it } from "vitest";
import { aggregateKbResults } from "./export-kb-scorecard";
import type { KbRunResultRow } from "./export-kb-scorecard";

function row(overrides: Partial<KbRunResultRow> = {}): KbRunResultRow {
  return {
    model: "model-a",
    axis: "happy",
    passed: true,
    tags: [],
    notes: [],
    latencyMs: 100,
    ...overrides,
  };
}

describe("aggregateKbResults", () => {
  it("returns one cell per KB_EVAL_AXES entry, in axis order", () => {
    const cells = aggregateKbResults([row({ axis: "happy" })]);
    expect(cells.map((c) => c.axis)).toEqual([
      "happy",
      "path-citation",
      "dedup",
      "multi-hop",
      "distractor",
      "cross-lingual",
    ]);
  });

  it("groups rows into their gold axis and reports totalRuns per axis", () => {
    const rows: KbRunResultRow[] = [
      row({ axis: "happy", model: "model-a" }),
      row({ axis: "happy", model: "model-a" }),
      row({ axis: "cross-lingual", model: "model-a" }),
    ];
    const cells = aggregateKbResults(rows);

    const happy = cells.find((c) => c.axis === "happy")!;
    expect(happy.totalRuns).toBe(2);

    const crossLingual = cells.find((c) => c.axis === "cross-lingual")!;
    expect(crossLingual.totalRuns).toBe(1);

    const dedup = cells.find((c) => c.axis === "dedup")!;
    expect(dedup.totalRuns).toBe(0);
    expect(dedup.models).toEqual([]);
  });

  it("produces per-model scorecard entries (passRate, wilson95, passCaretK, tagHistogram) within an axis", () => {
    const rows: KbRunResultRow[] = [
      row({ axis: "happy", model: "model-a", passed: true }),
      row({ axis: "happy", model: "model-a", passed: false, tags: ["ungrounded-claim"] }),
      row({ axis: "happy", model: "model-b", passed: true }),
    ];
    const cells = aggregateKbResults(rows);
    const happy = cells.find((c) => c.axis === "happy")!;

    expect(happy.models.map((m) => m.model).sort()).toEqual(["model-a", "model-b"]);

    const modelA = happy.models.find((m) => m.model === "model-a")!;
    expect(modelA.n).toBe(2);
    expect(modelA.passes).toBe(1);
    expect(modelA.passRate).toBeCloseTo(0.5, 5);
    expect(modelA.wilson95).toHaveLength(2);
    expect(modelA.wilson95[0]).toBeGreaterThanOrEqual(0);
    expect(modelA.wilson95[1]).toBeLessThanOrEqual(1);
    expect(modelA.passCaretK).toBe(0);
    expect(modelA.tagHistogram["ungrounded-claim"]).toBe(1);

    const modelB = happy.models.find((m) => m.model === "model-b")!;
    expect(modelB.n).toBe(1);
    expect(modelB.passes).toBe(1);
    expect(modelB.passCaretK).toBe(1);
  });

  it("returns an empty cell set for no rows", () => {
    const cells = aggregateKbResults([]);
    expect(cells.every((c) => c.totalRuns === 0 && c.models.length === 0)).toBe(true);
  });

  it("excludes run-infra-error rows from a cell's n (invalid trials, not model failures)", () => {
    // 2 clean runs (1 pass, 1 genuine model failure) + 1 harness flake tagged
    // run-infra-error. The infra row must NOT count toward n, passes, or the
    // tag histogram — otherwise a harness timeout would depress passRate and
    // zero passCaretK, conflating harness reliability with model quality.
    const rows: KbRunResultRow[] = [
      row({ axis: "happy", model: "model-a", passed: true }),
      row({ axis: "happy", model: "model-a", passed: false, tags: ["ungrounded-claim"] }),
      row({ axis: "happy", model: "model-a", passed: false, tags: ["run-infra-error"] }),
    ];
    const cells = aggregateKbResults(rows);
    const happy = cells.find((c) => c.axis === "happy")!;

    // n = 2 (the two valid trials), NOT 3 — the infra row is excluded.
    expect(happy.totalRuns).toBe(2);
    expect(happy.excludedInfraErrors).toBe(1);

    const modelA = happy.models.find((m) => m.model === "model-a")!;
    expect(modelA.n).toBe(2);
    expect(modelA.passes).toBe(1);
    expect(modelA.passRate).toBeCloseTo(0.5, 5);
    // The run-infra-error tag never reaches the histogram (row excluded).
    expect(modelA.tagHistogram["run-infra-error"]).toBeUndefined();
    expect(modelA.tagHistogram["ungrounded-claim"]).toBe(1);
  });

  it("a model whose every run is run-infra-error yields no scorecard entry (n would be 0)", () => {
    // A cell where the only runs are invalid trials must not manufacture a
    // 0/0 model row — buildScorecard only sees valid trials, and there are
    // none, so the model simply does not appear.
    const rows: KbRunResultRow[] = [
      row({ axis: "happy", model: "flaky-model", passed: false, tags: ["run-infra-error"] }),
      row({ axis: "happy", model: "flaky-model", passed: false, tags: ["run-infra-error"] }),
    ];
    const cells = aggregateKbResults(rows);
    const happy = cells.find((c) => c.axis === "happy")!;

    expect(happy.totalRuns).toBe(0);
    expect(happy.excludedInfraErrors).toBe(2);
    expect(happy.models).toEqual([]);
  });
});

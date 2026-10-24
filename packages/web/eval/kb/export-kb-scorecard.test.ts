// packages/web/eval/kb/export-kb-scorecard.test.ts
//
// Unit test of the AGGREGATION SHAPE only — `aggregateKbResults` is a pure
// function over hand-built `KbRunResultRow[]` fixtures, no filesystem I/O
// (that's `main()`'s job, exercised by running the script for real, not by
// this test). Mirrors the fact that `eval/export-scorecard.ts` (the invoice
// twin) has no unit coverage today; this is the KB harness's read-side
// insurance that the per-axis/per-model consolidation shape is right before
// it ever gets wired to real Task 3.4 output.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateKbResults, readAllRows } from "./export-kb-scorecard";
import type { KbRunResultRow } from "./export-kb-scorecard";
import { infraErrorRun } from "./run-kb-eval";
import { GOLD_QA } from "./corpus/gold-qa";
import { KB_EVAL_AXES } from "../../src/lib/eval/kb/types";
import { KB_EVAL_CANARY_JSONL_LINE } from "../canary";

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
      "freshness",
      "crowding",
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

/**
 * The runner writes these rows; this file reads them. Until #869 nothing held
 * the two together, and they had in fact drifted: the sweep stamped `scenario`
 * (the gold id) and no `axis`, while `aggregateKbResults` groups by `axis`.
 * Every axis cell would have come back empty from a dataset that was complete
 * — the failure mode this whole harness keeps producing, an output that reads
 * as "nothing here" when the truth is "read wrong".
 *
 * So these drive the ACTUAL producers rather than restating their shape.
 */
describe("what the sweep writes is what the exporter reads", () => {
  it("groups a row the runner produced into that row's axis cell", () => {
    // `infraErrorRun` is the one row the sweep builds in code rather than by
    // spreading a grader result, so it is the producer a drift would hit first
    // — and it is also the row most easily forgotten, being excluded from n.
    const written = infraErrorRun("model-a", "gqa-pathcite-1", "path-citation", new Error("x"), 0);

    const cells = aggregateKbResults([written]);
    const cell = cells.find((c) => c.axis === "path-citation");

    expect(cell).toBeDefined();
    // Excluded from n as an invalid trial, but PRESENT — an axis whose runs all
    // failed on infrastructure must read as unmeasured, not as untested.
    expect(cell?.excludedInfraErrors).toBe(1);
  });

  it("puts every axis the gold set exercises on the map", () => {
    // A gold item whose axis the exporter does not know would vanish from the
    // report entirely. `KB_EVAL_AXES` is the exporter's cell list, `GOLD_QA` is
    // what the sweep actually runs — a new gold axis must appear in both.
    const goldAxes = new Set(GOLD_QA.map((g) => g.axis));

    // Corpus floor FIRST: a `for` loop over an empty set is zero assertions
    // and a green test. That is how a coverage guard becomes decoration, and
    // the failure would arrive as "the gold set is fine" — the exact reading
    // this harness has produced wrongly four times.
    expect(goldAxes.size).toBeGreaterThan(0);

    for (const axis of goldAxes) {
      expect(KB_EVAL_AXES).toContain(axis);
    }
  });

  it("pins the coverage gap the published README states", () => {
    // `data/README.md` tells readers, in print, that two of the eight axes
    // have no gold questions and that their empty cells mean UNMEASURED. The
    // day someone writes those questions the sentence becomes false, and a
    // doc that says "nobody has measured this" about measured data is worse
    // than no doc. Closing the gap must therefore fail here first.
    const goldAxes = new Set<string>(GOLD_QA.map((g) => g.axis));
    const uncovered = KB_EVAL_AXES.filter((a) => !goldAxes.has(a));

    expect(uncovered).toEqual(["freshness", "crowding"]);
  });
});

/**
 * `readAllRows` is where a published number is actually assembled, and it was
 * the untested half of #869. Measured, not reasoned: pointed at the committed
 * 48-run dataset WITHOUT the name filter, the exporter reports
 * `totalRuns: 96` — the trajectories were never "harmlessly dropped", they
 * were already doubling the headline. So the filter is load-bearing and gets
 * a guard, not a comment.
 */
describe("readAllRows", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function dataDir(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "kb-scorecard-"));
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(dir, name), text, "utf8");
    }
    return dir;
  }

  const runLine = (axis: string) =>
    JSON.stringify({ model: "m", axis, passed: true, tags: [], notes: [], latencyMs: 1 });

  it("reads run rows and skips the trajectories sidecar by NAME, not by its shape", async () => {
    // The trajectory line here deliberately carries a valid `axis`. Today's
    // sidecar has none, which is why an axis-based drop happened to work —
    // luck the moment `PersistedKbTrajectory` gains a field. This fixture is
    // that tomorrow, held today.
    const d = await dataDir({
      "sweep.jsonl": `${runLine("happy")}\n${runLine("dedup")}\n`,
      "sweep.trajectories.jsonl": `${JSON.stringify({ model: "m", axis: "happy", answer: "…" })}\n`,
    });

    const rows = await readAllRows(d);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.axis)).toEqual(["happy", "dedup"]);
  });

  it("skips the canary header line instead of counting it as a run", async () => {
    const d = await dataDir({
      "sweep.jsonl": `${KB_EVAL_CANARY_JSONL_LINE}\n${runLine("happy")}\n`,
    });

    expect(await readAllRows(d)).toHaveLength(1);
  });

  it("throws on a row with no axis, naming the file and line", async () => {
    // The pre-#869 row shape, and still reachable: a resumed sweep's
    // `results/` mixes rows written before the fix, and `data/` is filled by
    // copying that file. Silently dropping such a row is the original bug
    // wearing a different hat — 48 runs in, every axis cell at n=0, and a
    // `totalRuns` that says the data is all there. It has to be loud.
    const d = await dataDir({
      "sweep.jsonl": `${runLine("happy")}\n${JSON.stringify({ model: "m", scenario: "gqa-happy-1", passed: true, tags: [], notes: [], latencyMs: 1 })}\n`,
    });

    await expect(readAllRows(d)).rejects.toThrow(/sweep\.jsonl line 2/);
  });

  it("names the file and line when a line is not valid JSON", async () => {
    // Same reason the axis check is loud, one step earlier: a sweep killed
    // mid-`appendFile` leaves a truncated last line, and `data/` is filled by
    // copying that file. A bare `SyntaxError: Unexpected end of JSON input`
    // names neither the file nor the line of a 49-line dataset.
    const d = await dataDir({ "sweep.jsonl": `${runLine("happy")}\n{"model":"m","axis":` });

    await expect(readAllRows(d)).rejects.toThrow(/sweep\.jsonl line 2/);
  });

  it("throws on an axis that is not a known KB_EVAL_AXES member", async () => {
    const d = await dataDir({ "sweep.jsonl": `${runLine("retrieval-vibes")}\n` });

    await expect(readAllRows(d)).rejects.toThrow(/retrieval-vibes/);
  });

  it("returns no rows when the directory does not exist", async () => {
    expect(await readAllRows(path.join(tmpdir(), "kb-scorecard-does-not-exist"))).toEqual([]);
  });
});

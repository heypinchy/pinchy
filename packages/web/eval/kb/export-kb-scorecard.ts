/**
 * Exports curated KB eval results (packages/web/eval/kb/data) as one
 * consolidated JSON, mirroring `../export-scorecard.ts`'s role for the
 * invoice harness (KB Eval Harness plan, Task 3.5):
 *
 *   pnpm -C packages/web tsx eval/kb/export-kb-scorecard.ts > /tmp/kb-reliability.json
 *
 * Input shape: every `*.jsonl` file directly under `eval/kb/data/` is read
 * and concatenated. Each line is a `KbRunResultRow` — a `KbRunResult`
 * (`../../src/lib/eval/kb/answer-graders.ts`) plus the gold query's `axis`
 * the run answered. The Task 3.4 runner (not yet built) is expected to write
 * files in this directory in this shape; any number of files, any names —
 * this script does not care which run produced which file, only that every
 * row carries `axis` alongside the standard KbRunResult fields.
 *
 * Consolidation: `aggregateKbResults` groups rows by `axis` (one cell per
 * `KB_EVAL_AXES` entry, always present even with zero rows — mirrors
 * `retrieval-eval.ts`'s `aggregate()` so an axis never silently vanishes from
 * the report just because no curated data exists for it yet), then reuses
 * `buildScorecard<KbFailureTag>` (Task 3.5's whole point in generalizing
 * `RunResult`/`buildScorecard`, see `../../src/lib/eval/scorecard.ts`) to get
 * per-model passRate + Wilson95 + pass^k + tagHistogram for FREE, with no
 * reimplementation and no cast.
 *
 * Invalid trials: the invoice exporter excludes `run-infra-error`-tagged runs
 * from a cell's n (a harness/transport failure — the model never produced a
 * gradeable answer, so the run is neither a pass nor a model failure).
 * `KbFailureTag` (`../../src/lib/eval/kb/types.ts`) now carries the same
 * `run-infra-error` marker (Task 3.4's sweep tags a timeout/capture/dispatch
 * failure with it), so `aggregateKbResults` filters those rows out before
 * `buildScorecard` sees them — otherwise every harness flake would depress a
 * model's passRate and zero its passCaretK, conflating harness reliability
 * with model quality. This mirrors `../export-scorecard.ts`'s `aggregate()`
 * exactly.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildScorecard, type ScorecardEntry } from "../../src/lib/eval/scorecard";
import { KB_EVAL_AXES } from "../../src/lib/eval/kb/types";
import type { KbEvalAxis, KbFailureTag } from "../../src/lib/eval/kb/types";
import type { KbRunResult } from "../../src/lib/eval/kb/answer-graders";

const DATA_DIR = path.join(__dirname, "data");

/** One curated KB run result row: a `KbRunResult` plus the axis its gold query exercises. */
export interface KbRunResultRow extends KbRunResult {
  axis: KbEvalAxis;
}

export interface KbAxisCell {
  axis: KbEvalAxis;
  /**
   * Rows in this axis that count toward the scorecard — i.e. valid trials,
   * AFTER excluding `run-infra-error` invalid trials. This is the `n` the
   * per-model `models` entries are computed over, NOT the raw row count.
   */
  totalRuns: number;
  /** `run-infra-error` rows excluded from `totalRuns`/`models` as invalid trials (harness flakes, not model failures). */
  excludedInfraErrors: number;
  /** Per-model scorecard entries within this axis — see `ScorecardEntry` (../../src/lib/eval/scorecard.ts). */
  models: ScorecardEntry[];
}

/**
 * Groups `rows` by axis (one cell per `KB_EVAL_AXES` entry, in that order,
 * even for an axis with zero rows) and builds a per-model scorecard within
 * each axis via `buildScorecard<KbFailureTag>`. Pure — no I/O — so it is
 * unit-testable directly with hand-built fixtures (see
 * `export-kb-scorecard.test.ts`).
 *
 * Invalid trials (`run-infra-error`) are filtered out BEFORE `buildScorecard`
 * so they never inflate n or count as model failures — see the module doc
 * comment and `../export-scorecard.ts`'s identical exclusion. `totalRuns` is
 * the post-exclusion valid-trial count; `excludedInfraErrors` reports how
 * many were dropped so a reader can tell an honestly-thin cell from a
 * flake-riddled one.
 */
export function aggregateKbResults(rows: KbRunResultRow[]): KbAxisCell[] {
  return KB_EVAL_AXES.map((axis) => {
    const axisRows = rows.filter((r) => r.axis === axis);
    const validRows = axisRows.filter((r) => !r.tags.includes("run-infra-error"));
    const kbRuns: KbRunResult[] = validRows.map(({ axis: _axis, ...rest }) => rest);
    return {
      axis,
      totalRuns: validRows.length,
      excludedInfraErrors: axisRows.length - validRows.length,
      models: buildScorecard<KbFailureTag>(kbRuns),
    };
  });
}

async function readAllRows(): Promise<KbRunResultRow[]> {
  let files: string[];
  try {
    files = (await readdir(DATA_DIR)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const rows: KbRunResultRow[] = [];
  for (const file of files) {
    const text = await readFile(path.join(DATA_DIR, file), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      rows.push(JSON.parse(line) as KbRunResultRow);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const rows = await readAllRows();
  const axes = aggregateKbResults(rows);

  const out = {
    generatedFrom: "packages/web/eval/kb/data (heypinchy/pinchy)",
    totalRuns: rows.length,
    axes,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

// Only run when invoked directly (`tsx eval/kb/export-kb-scorecard.ts`), NOT
// when imported — `export-kb-scorecard.test.ts` imports `aggregateKbResults`
// from this module, and a bare `void main()` at module scope would fire the
// file-reading/stdout side effect on every test run too.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}

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
 * from a cell's n (the LLM request itself died — not a graded model
 * behavior). `KbFailureTag` (`../../src/lib/eval/kb/types.ts`) has NO
 * equivalent tag today — every KB failure mode is a genuine grading outcome
 * (retrieval, attribution, groundedness, or relevance), not a dead transport
 * call — so there is nothing to filter here. If a future KB harness change
 * introduces an infra-failure marker tag, add the same exclusion this
 * comment describes, mirroring `../export-scorecard.ts`'s `aggregate()`.
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
  totalRuns: number;
  /** Per-model scorecard entries within this axis — see `ScorecardEntry` (../../src/lib/eval/scorecard.ts). */
  models: ScorecardEntry[];
}

/**
 * Groups `rows` by axis (one cell per `KB_EVAL_AXES` entry, in that order,
 * even for an axis with zero rows) and builds a per-model scorecard within
 * each axis via `buildScorecard<KbFailureTag>`. Pure — no I/O — so it is
 * unit-testable directly with hand-built fixtures (see
 * `export-kb-scorecard.test.ts`).
 */
export function aggregateKbResults(rows: KbRunResultRow[]): KbAxisCell[] {
  return KB_EVAL_AXES.map((axis) => {
    const axisRows = rows.filter((r) => r.axis === axis);
    const kbRuns: KbRunResult[] = axisRows.map(({ axis: _axis, ...rest }) => rest);
    return {
      axis,
      totalRuns: axisRows.length,
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

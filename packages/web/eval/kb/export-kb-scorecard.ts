/**
 * Exports curated KB eval results (packages/web/eval/kb/data) as one
 * consolidated JSON, mirroring `../export-scorecard.ts`'s role for the
 * invoice harness (KB Eval Harness plan, Task 3.5):
 *
 *   pnpm -C packages/web tsx eval/kb/export-kb-scorecard.ts > /tmp/kb-reliability.json
 *
 * Input shape: every `*.jsonl` file directly under `eval/kb/data/` is read
 * and concatenated, EXCEPT `*.trajectories.jsonl` — that sidecar holds the
 * evidence (raw answers, retrieved passages) behind the verdicts, not run
 * rows, and counting it doubles `totalRuns`. Any number of files, any names,
 * subject to that one suffix.
 *
 * Each remaining line is a `KbRunResultRow` — a `KbRunResult`
 * (`../../src/lib/eval/kb/answer-graders.ts`) plus the gold query's `axis`
 * the run answered — or the contamination-canary header, which is skipped.
 * A row with no known `axis` is a hard error rather than a silent drop: see
 * `readAllRows`.
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
import { isCanaryLine } from "../canary";
import { parseJsonlLine } from "../jsonl-line";
import { buildScorecard, type ScorecardEntry } from "../../src/lib/eval/scorecard";
import { KB_EVAL_AXES } from "../../src/lib/eval/kb/types";
import type { KbEvalAxis, KbFailureTag, KbRunResultRow } from "../../src/lib/eval/kb/types";
import type { KbRunResult } from "../../src/lib/eval/kb/answer-graders";

const DATA_DIR = path.join(__dirname, "data");

// Re-exported, not redeclared: the runner writes this shape and this file
// reads it, so both import one definition from `types.ts`. See its doc comment
// for what silently went wrong when they were two.
export type { KbRunResultRow };

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

const KNOWN_AXES = new Set<string>(KB_EVAL_AXES);

/**
 * Reads every published run row under `dataDir`.
 *
 * Exported (and parameterized) so the assembly of a PUBLISHED number is under
 * test rather than only the pure aggregation downstream of it — this is the
 * half of the exporter that #869's row-shape drift actually passed through.
 *
 * Three things it refuses to do quietly:
 *
 * - **`*.trajectories.jsonl` is skipped by NAME.** The answers are published
 *   beside the verdicts so a reader can check a tag against what the model
 *   actually wrote, but its lines are not run rows. Dropping them by shape
 *   (they carry no `axis` today) held only by luck — and not even that far:
 *   measured against the committed 48-run dataset, an unfiltered read reports
 *   `totalRuns: 96`.
 * - **A row whose `axis` is missing or unknown THROWS**, naming file and line.
 *   Such a row groups into nothing while still counting toward `totalRuns`,
 *   so the report would read "48 runs, every axis untested" — the exact
 *   failure #869 exists to end, and one a resumed pre-fix sweep can still
 *   write. An extractor that cannot read its input must say so; returning a
 *   short list reads as "there was nothing there".
 * - **A line that is not valid JSON throws by file and line too**, via
 *   `parseJsonlLine`. `JSON.parse`'s own error names neither, and the case is
 *   ordinary rather than exotic: `appendFile` is not atomic, so a sweep killed
 *   mid-write leaves a truncated last line in the very file `data/` is copied
 *   from.
 */
export async function readAllRows(dataDir: string = DATA_DIR): Promise<KbRunResultRow[]> {
  let files: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied dir, test-only parameter; defaults to the module's own data/
    files = (await readdir(dataDir)).filter(
      (f) => f.endsWith(".jsonl") && !f.endsWith(".trajectories.jsonl")
    );
  } catch {
    return [];
  }

  const rows: KbRunResultRow[] = [];
  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- name comes from readdir of the directory above
    const text = await readFile(path.join(dataDir, file), "utf8");
    // Line numbers are 1-based and count the canary/blank lines, so an error
    // names the line a reader would open the file to.
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo++;
      if (line.trim().length === 0 || isCanaryLine(line)) continue;
      const row = parseJsonlLine(file, lineNo, line) as KbRunResultRow;
      if (!KNOWN_AXES.has(row.axis)) {
        throw new Error(
          `${file} line ${lineNo}: run row has no known axis (got ${JSON.stringify(row.axis)}). ` +
            `Every published row must carry one of: ${KB_EVAL_AXES.join(", ")}.`
        );
      }
      rows.push(row);
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

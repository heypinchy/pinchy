/**
 * Offline re-grader for Eval-v1 (pinchy#669).
 *
 * Reads a persisted trajectory log (`results/<label>.trajectories.jsonl`,
 * written by `appendTrajectory` in run-eval.ts) and RE-SCORES every run with
 * the CURRENT graders — no models, no stack, no budget. This is the payoff of
 * persisting full trajectories: a grader change (e.g. hardening the
 * false-success detector) can be validated against real captured output and
 * the whole scorecard rebuilt without a re-sweep.
 *
 * Usage:  pnpm -C packages/web tsx eval/regrade.ts <label> [--quotes]
 *   e.g.  pnpm -C packages/web tsx eval/regrade.ts hetzner-invoice-silent-failure-models --quotes
 *
 * `--quotes` also prints the final-message snippet for every run the grader
 * marks false-success — the evidence corpus for the writeup.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEvalJsonl } from "./canary";
import { gradeRunForScenario } from "../src/lib/eval/graders";
import { buildScorecard, primaryRuns } from "../src/lib/eval/scorecard";
import type { PromptVariantId, RunResult, RunTrajectory } from "../src/lib/eval/types";
import { hetznerInvoiceScenario, type HetznerInvoiceScenario } from "./scenarios/hetzner-invoice";
import { hetznerInvoiceRejectedScenario } from "./scenarios/hetzner-invoice-rejected";
import { hetznerInvoiceSilentFailureScenario } from "./scenarios/hetzner-invoice-silent-failure";
import { hetznerInvoiceDuplicateScenario } from "./scenarios/hetzner-invoice-duplicate";
import { hetznerInvoiceDistractorScenario } from "./scenarios/hetzner-invoice-distractor";
import { hetznerInvoiceConflictScenario } from "./scenarios/hetzner-invoice-conflict";
import { hetznerInvoiceLineItemsScenario } from "./scenarios/hetzner-invoice-lineitems";

const SCENARIO_BY_LABEL: Record<string, HetznerInvoiceScenario> = {
  "hetzner-invoice-models": hetznerInvoiceScenario,
  "hetzner-invoice-rejected-models": hetznerInvoiceRejectedScenario,
  "hetzner-invoice-silent-failure-models": hetznerInvoiceSilentFailureScenario,
  "hetzner-invoice-duplicate-models": hetznerInvoiceDuplicateScenario,
  "hetzner-invoice-distractor-models": hetznerInvoiceDistractorScenario,
  "hetzner-invoice-conflict-models": hetznerInvoiceConflictScenario,
  "hetzner-invoice-lineitems-models": hetznerInvoiceLineItemsScenario,
};

/**
 * One line of a `results/<label>.trajectories.jsonl` log: the normalized
 * trajectory plus the grade the sweep stored — and, for post-Task-15 dumps,
 * the `promptVariant` the run was dispatched with. Optional because rows
 * persisted by pre-variant sweeps lack the field (absence means primary).
 */
export type TrajectoryRecord = RunTrajectory & {
  passed?: boolean;
  tags?: string[];
  promptVariant?: PromptVariantId;
};

/**
 * Re-scores one persisted trajectory record with the CURRENT graders and
 * rebuilds its RunResult. `promptVariant` is carried through when the record
 * has one — dropping it would grandfather a paraphrase run into "primary" and
 * conflate variants in the rebuilt scorecard. A legacy record without the
 * field yields a RunResult without the key (absence stays absence).
 */
export function rebuildRunResult(
  rec: TrajectoryRecord,
  scenario: HetznerInvoiceScenario,
  label: string
): RunResult {
  const traj: RunTrajectory = {
    model: rec.model,
    toolCalls: rec.toolCalls,
    finalMessage: rec.finalMessage,
    odooMoves: rec.odooMoves,
    odooRecordsByModel: rec.odooRecordsByModel,
    latencyMs: rec.latencyMs,
    tokens: rec.tokens,
  };
  const graded = gradeRunForScenario(traj, scenario);
  return {
    ...graded,
    model: rec.model,
    scenario: label,
    latencyMs: rec.latencyMs,
    ...(rec.promptVariant !== undefined ? { promptVariant: rec.promptVariant } : {}),
  };
}

async function main(): Promise<void> {
  const label = process.argv[2];
  const withQuotes = process.argv.includes("--quotes");
  if (!label || !SCENARIO_BY_LABEL[label]) {
    console.error(`Usage: tsx eval/regrade.ts <label> [--quotes]`);
    console.error(`Known labels: ${Object.keys(SCENARIO_BY_LABEL).join(", ")}`);
    process.exit(1);
    return;
  }
  const scenario = SCENARIO_BY_LABEL[label];
  const filePath = path.join(__dirname, "results", `${label}.trajectories.jsonl`);
  const text = await readFile(filePath, "utf8");
  const records = parseEvalJsonl<TrajectoryRecord>(text);

  const results: RunResult[] = [];
  const flips: string[] = [];
  const quotes: string[] = [];
  for (const rec of records) {
    const graded = rebuildRunResult(rec, scenario, label);
    results.push(graded);

    if (typeof rec.passed === "boolean" && rec.passed !== graded.passed) {
      flips.push(
        `  ${rec.model.split("/").pop()}: old passed=${String(rec.passed)} -> new passed=${String(
          graded.passed
        )} [${graded.tags.join(",")}]`
      );
    }
    if (withQuotes && graded.tags.includes("false-success")) {
      const snippet = rec.finalMessage.replace(/\s+/g, " ").slice(0, 220);
      quotes.push(`  [${rec.model.split("/").pop()}] "${snippet}…"`);
    }
  }

  // Primary-only, like every other headline aggregation (#803): a variant-
  // bearing log holds paraphrase runs of the SAME model and scenario, so an
  // unfiltered scorecard would pool a wording probe into the re-graded pass
  // rate — the number this CLI exists to check the published one against.
  const headlineRuns = primaryRuns(results);
  const scorecard = buildScorecard(headlineRuns);
  const excludedVariantRuns = results.length - headlineRuns.length;
  console.log(`\n=== Re-grade "${label}" (${String(headlineRuns.length)} primary runs) ===`);
  if (excludedVariantRuns > 0) {
    console.log(
      `(${String(excludedVariantRuns)} paraphrase-variant run(s) excluded — the headline is ` +
        `primary-only; see the export's robustness block for their pass rates)`
    );
  }
  for (const e of scorecard) {
    console.log(
      `${e.model.padEnd(40)} pass=${String(e.passes)}/${String(e.n)} rate=${e.passRate.toFixed(
        2
      )} pass^k=${String(e.passCaretK)} tags=${JSON.stringify(e.tagHistogram)}`
    );
  }
  if (flips.length > 0) {
    console.log(`\n--- ${String(flips.length)} grade FLIPS vs the log's stored grade ---`);
    console.log(flips.join("\n"));
  }
  if (withQuotes && quotes.length > 0) {
    console.log(`\n--- false-success quotes (${String(quotes.length)}) ---`);
    console.log(quotes.join("\n"));
  }
}

// Only when run as the CLI — importers (the rebuild test) want `rebuildRunResult`,
// not a usage error and a process.exit on their test runner.
if (require.main === module) void main();

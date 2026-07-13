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
import { gradeRunForScenario } from "../src/lib/eval/graders";
import { buildScorecard } from "../src/lib/eval/scorecard";
import type { RunResult, RunTrajectory } from "../src/lib/eval/types";
import { hetznerInvoiceScenario, type HetznerInvoiceScenario } from "./scenarios/hetzner-invoice";
import { hetznerInvoiceRejectedScenario } from "./scenarios/hetzner-invoice-rejected";
import { hetznerInvoiceSilentFailureScenario } from "./scenarios/hetzner-invoice-silent-failure";
import { hetznerInvoiceDuplicateScenario } from "./scenarios/hetzner-invoice-duplicate";
import { hetznerInvoiceDistractorScenario } from "./scenarios/hetzner-invoice-distractor";
import { hetznerInvoiceConflictScenario } from "./scenarios/hetzner-invoice-conflict";

const SCENARIO_BY_LABEL: Record<string, HetznerInvoiceScenario> = {
  "hetzner-invoice-models": hetznerInvoiceScenario,
  "hetzner-invoice-rejected-models": hetznerInvoiceRejectedScenario,
  "hetzner-invoice-silent-failure-models": hetznerInvoiceSilentFailureScenario,
  "hetzner-invoice-duplicate-models": hetznerInvoiceDuplicateScenario,
  "hetzner-invoice-distractor-models": hetznerInvoiceDistractorScenario,
  "hetzner-invoice-conflict-models": hetznerInvoiceConflictScenario,
};

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
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const results: RunResult[] = [];
  const flips: string[] = [];
  const quotes: string[] = [];
  for (const line of lines) {
    const rec = JSON.parse(line) as RunTrajectory & { passed?: boolean; tags?: string[] };
    const traj: RunTrajectory = {
      model: rec.model,
      toolCalls: rec.toolCalls,
      finalMessage: rec.finalMessage,
      odooMoves: rec.odooMoves,
      latencyMs: rec.latencyMs,
      tokens: rec.tokens,
    };
    const graded = gradeRunForScenario(traj, scenario);
    results.push({ ...graded, model: rec.model, scenario: label, latencyMs: rec.latencyMs });

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

  const scorecard = buildScorecard(results);
  console.log(`\n=== Re-grade "${label}" (${String(results.length)} runs) ===`);
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

void main();

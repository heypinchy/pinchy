/**
 * Exports the published Eval-v1 dataset (packages/web/eval/data) as one
 * consolidated JSON for downstream surfaces (the heypinchy.com /reliability
 * hub renders from a copy of this output). Committed so the website's numbers
 * are reproducible from the open dataset with one command:
 *
 *   pnpm -C packages/web tsx eval/export-scorecard.ts > /tmp/reliability.json
 *
 * Grading source per scenario:
 * - `hetzner-invoice-duplicate-models` is RE-GRADED from its (complete)
 *   trajectory log with the CURRENT graders — some early stored RunResults
 *   predate the verify-required duplicate grader fix.
 * - `hetzner-invoice-silent-failure-models` is RE-GRADED too: the stored
 *   RunResults predate `detectInfraError`, so 17 transport-errored runs were
 *   credited as honest passes.
 * - `hetzner-invoice-rejected-models` is RE-GRADED too: the stored RunResults
 *   predate the #740 false-success fix, so honest hard-rejection runs (a model
 *   that reports the create was refused) were wrongly tagged false-success.
 *   Only 4 runs have trajectories and they are NOT a prefix of the stored
 *   rows, so the overlay joins by (model, latencyMs) — see applyTrajectoryRegrade.
 * - All other scenarios use the stored RunResults: they were collected with
 *   the current grader generation, and their earliest runs (happy's original
 *   cohort) have no trajectories to re-grade from.
 * Rows without a trajectory (run-timeouts are logged directly, bypassing the
 * trajectory dump) keep their stored failed grade in every mode.
 *
 * Invalid trials: runs tagged `run-infra-error` (the LLM request itself died;
 * the model never answered) are neither passes nor model failures. They are
 * EXCLUDED from a cell's n and the cell is marked `pendingRerun` until the
 * re-run restores full coverage — unlike model hangs (`run-timeout`), which
 * are model behavior and stay graded as failures.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gradeRunForScenario } from "../src/lib/eval/graders";
import { pooledClusteredDifference, tiedWithLeader } from "../src/lib/eval/comparisons";
import { applyTrajectoryRegrade } from "../src/lib/eval/regrade-merge";
import type { RunResult, RunTrajectory } from "../src/lib/eval/types";
import { hetznerInvoiceDuplicateScenario } from "./scenarios/hetzner-invoice-duplicate";
import { hetznerInvoiceRejectedScenario } from "./scenarios/hetzner-invoice-rejected";
import { hetznerInvoiceSilentFailureScenario } from "./scenarios/hetzner-invoice-silent-failure";

const DATA_DIR = path.join(__dirname, "data");

/** Scenario labels in presentation order, with the axis each one measures. */
const SCENARIOS = [
  { label: "hetzner-invoice-models", slug: "happy-path", axis: "task capability" },
  {
    label: "hetzner-invoice-distractor-models",
    slug: "distractor-inbox",
    axis: "document selection",
  },
  {
    label: "hetzner-invoice-conflict-models",
    slug: "conflicting-data",
    axis: "extraction discipline",
  },
  { label: "hetzner-invoice-lineitems-models", slug: "line-items", axis: "structured data entry" },
  {
    label: "hetzner-invoice-duplicate-models",
    slug: "duplicate-guard",
    axis: "verify before write",
  },
  {
    label: "hetzner-invoice-rejected-models",
    slug: "hard-rejection",
    axis: "honesty under loud failure",
  },
  {
    label: "hetzner-invoice-silent-failure-models",
    slug: "silent-failure",
    axis: "honesty under silent failure",
  },
] as const;

/** Scenarios whose published grade comes from re-grading trajectories. */
const REGRADE_FROM_TRAJECTORIES = new Map([
  ["hetzner-invoice-duplicate-models", hetznerInvoiceDuplicateScenario],
  ["hetzner-invoice-silent-failure-models", hetznerInvoiceSilentFailureScenario],
  // Re-graded so the #740 grader fix (honest hard-rejection runs were wrongly
  // tagged false-success) reaches the published numbers. Only 4 of the runs
  // have trajectories, and they are NOT a prefix of the stored rows, so the
  // overlay joins by (model, latencyMs) — see applyTrajectoryRegrade.
  ["hetzner-invoice-rejected-models", hetznerInvoiceRejectedScenario],
]);

interface Cell {
  model: string;
  n: number;
  passes: number;
  passRate: number;
  passAllK: boolean;
  /** Wilson 95% score interval for the pass rate, at this cell's n. */
  wilson95: [number, number];
  /** Transport-errored runs excluded from n as invalid trials. */
  excludedInfraErrors: number;
  /** True while excluded runs await their re-run (coverage below target). */
  pendingRerun: boolean;
  tagHistogram: Record<string, number>;
}

/** Wilson 95% score interval for `passes` successes in `n` trials. */
function wilson95(passes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = passes / n;
  const denom = 1 + z ** 2 / n;
  const center = p + z ** 2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z ** 2 / (4 * n ** 2));
  return [
    Number(((center - margin) / denom).toFixed(3)),
    Number(((center + margin) / denom).toFixed(3)),
  ];
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(path.join(DATA_DIR, file), "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

function aggregate(runs: RunResult[]): Cell[] {
  const byModel = new Map<string, RunResult[]>();
  for (const r of runs) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  return [...byModel.entries()]
    .map(([model, all]) => {
      const list = all.filter((r) => !r.tags.includes("run-infra-error"));
      const excludedInfraErrors = all.length - list.length;
      const passes = list.filter((r) => r.passed).length;
      const tagHistogram: Record<string, number> = {};
      for (const r of list) {
        for (const t of r.tags) tagHistogram[t] = (tagHistogram[t] ?? 0) + 1;
      }
      const n = list.length;
      return {
        model: model.replace(/^ollama-cloud\//, ""),
        n,
        passes,
        passRate: n > 0 ? Number((passes / n).toFixed(3)) : 0,
        passAllK: passes === n && n > 0,
        wilson95: wilson95(passes, n),
        excludedInfraErrors,
        pendingRerun: excludedInfraErrors > 0,
        tagHistogram,
      };
    })
    .sort((a, b) => b.passRate - a.passRate || a.model.localeCompare(b.model));
}

export interface PublishedScenario {
  label: string;
  slug: string;
  axis: string;
  totalRuns: number;
  models: Cell[];
  /**
   * Every model this scenario's leader is NOT significantly ahead of (the
   * leader included). At n=12 most rank gaps aren't significant, so a reader
   * given only an ordered list would over-read it — this names the tie.
   */
  tiedWithLeader: string[];
}

/** A pooled, scenario-clustered comparison of two models across all scenarios. */
export interface ModelComparison {
  a: string;
  b: string;
  /** Mean of the per-scenario pass-rate differences, p(a) − p(b). */
  diff: number;
  /** 95% t-interval on the clustered SE (df = scenarios − 1). */
  ci: [number, number];
  /** True when the interval spans 0 — no detectable difference overall. */
  tied: boolean;
  scenarios: number;
}

const round3 = (v: number): number => Number(v.toFixed(3));

/**
 * Every unordered model pair, compared pooled across scenarios with a
 * scenario-clustered SE. Answers "is A actually better than B", which two
 * overlapping per-cell CIs cannot (Miller 2024).
 */
export function buildComparisons(scenarios: PublishedScenario[]): ModelComparison[] {
  const models = [...new Set(scenarios.flatMap((s) => s.models.map((m) => m.model)))].sort();
  const comparisons: ModelComparison[] = [];

  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const [a, b] = [models[i], models[j]];
      const pairs = scenarios.flatMap((s) => {
        const ca = s.models.find((m) => m.model === a);
        const cb = s.models.find((m) => m.model === b);
        return ca && cb
          ? [
              {
                a: { model: a, passes: ca.passes, n: ca.n },
                b: { model: b, passes: cb.passes, n: cb.n },
              },
            ]
          : [];
      });
      const pooled = pooledClusteredDifference(pairs);
      comparisons.push({
        a,
        b,
        diff: round3(pooled.diff),
        ci: [round3(pooled.ci[0]), round3(pooled.ci[1])],
        tied: pooled.tied,
        scenarios: pooled.scenarios,
      });
    }
  }
  return comparisons;
}

/**
 * The published scorecards: exactly what the CLI prints and the /reliability
 * hub renders, re-grades and all.
 *
 * Exported so the triage guard (`eval/__tests__/scorecard-triage-guard.test.ts`)
 * judges the SAME numbers we publish. The stored `data/<scenario>.json`
 * scorecards are not those numbers — three scenarios are re-graded here from
 * their trajectories, and the two disagree materially (deepseek-v3.2 on
 * duplicate-guard: 12/12 stored, 0/12 re-graded). A guard reading the stored
 * file would police cells that no reader ever sees.
 */
export async function buildPublishedScenarios(): Promise<PublishedScenario[]> {
  const scenarios: PublishedScenario[] = [];
  for (const s of SCENARIOS) {
    const stored = await readJsonl<RunResult>(`${s.label}.jsonl`);
    let runs: RunResult[] = stored;

    const regradeScenario = REGRADE_FROM_TRAJECTORIES.get(s.label);
    if (regradeScenario) {
      const trajectories = await readJsonl<RunTrajectory>(`${s.label}.trajectories.jsonl`);
      // Overlay the re-graded trajectory results onto the stored rows, joined
      // by (model, latencyMs). Trajectories can be a sparse, non-prefix subset
      // of the stored runs, so positional matching would regrade the wrong
      // rows — see applyTrajectoryRegrade. Rows with no trajectory (e.g.
      // run-timeouts) keep their stored grade; n is preserved. Throws if the
      // join key breaks, rather than publishing a silently stale cell.
      runs = applyTrajectoryRegrade(
        stored,
        trajectories,
        (traj) => ({ ...gradeRunForScenario(traj, regradeScenario), model: traj.model }),
        s.label
      );
    }

    const models = aggregate(runs);
    scenarios.push({
      label: s.label,
      slug: s.slug,
      axis: s.axis,
      totalRuns: runs.length,
      models,
      tiedWithLeader: tiedWithLeader(models),
    });
  }
  return scenarios;
}

async function main(): Promise<void> {
  const scenarios = await buildPublishedScenarios();
  const out = {
    generatedFrom: "packages/web/eval/data (heypinchy/pinchy)",
    scenarios,
    comparisons: buildComparisons(scenarios),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

// Only when run as the CLI: importers (the triage guard) want the data, not a
// dump on their stdout.
if (require.main === module) void main();

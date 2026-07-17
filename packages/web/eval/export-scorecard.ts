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
import { parseEvalJsonl } from "./canary";
import { gradeRunForScenario } from "../src/lib/eval/graders";
import { pooledClusteredDifference, tiedWithLeader } from "../src/lib/eval/comparisons";
import { applyTrajectoryRegrade } from "../src/lib/eval/regrade-merge";
import { passHatKCurve, wilsonInterval } from "../src/lib/eval/scorecard";
import type { RunResult, RunTrajectory } from "../src/lib/eval/types";
import { DATASET_VERSION } from "./dataset-version";
import { hetznerInvoiceDuplicateScenario } from "./scenarios/hetzner-invoice-duplicate";
import { hetznerInvoiceRejectedScenario } from "./scenarios/hetzner-invoice-rejected";
import { hetznerInvoiceSilentFailureScenario } from "./scenarios/hetzner-invoice-silent-failure";

const DATA_DIR = path.join(__dirname, "data");

/**
 * Scenario labels in presentation order, with the axis each one measures.
 *
 * Exported so the oracle coverage guard (`eval/__tests__/oracle-solutions.test.ts`)
 * binds `ORACLES` to this list rather than keeping a third hand-maintained copy
 * of the same label strings — a renamed label must break CI, not leave an
 * oracle silently pointing at a scenario nobody publishes.
 */
export const SCENARIOS = [
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
  /**
   * pass^k reliability curve (τ-bench estimator): the chance k runs in a row
   * all pass, at k = 1, 2, 4, 8, 12 (levels above n omitted). k=1 is the pass
   * rate; it decays as k grows. The reliability framing enterprises measure us
   * against — a model at 0.9 pass@1 can sit near 0.5 at pass^8.
   */
  passHatK: { k: number; value: number }[];
  /** Wilson 95% score interval for the pass rate, at this cell's n. */
  wilson95: [number, number];
  /** Transport-errored runs excluded from n as invalid trials. */
  excludedInfraErrors: number;
  /** True while excluded runs await their re-run (coverage below target). */
  pendingRerun: boolean;
  tagHistogram: Record<string, number>;
}

const round3 = (v: number): number => Number(v.toFixed(3));

/**
 * Wilson 95% score interval for `passes` successes in `n` trials, rounded for
 * publication. The maths lives in `src/lib/eval/scorecard.ts` — this file used
 * to carry a second copy that disagreed with it at n=0 ([0, 1] here, a [0, 0]
 * point mass there), which is a contradiction a reader of one exported record
 * could not see: the same zero-trial cell would publish "anything is possible"
 * in `wilson95` while `comparisons.ts` read "certainly 0%" off the other copy.
 */
const wilson95 = (passes: number, n: number): [number, number] => {
  const [lower, upper] = wilsonInterval(passes, n);
  return [round3(lower), round3(upper)];
};

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(path.join(DATA_DIR, file), "utf8");
    return parseEvalJsonl<T>(text);
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
        passHatK: passHatKCurve(passes, n),
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
  /**
   * Random-effects SE behind `ci`. Published so a reader can rebuild the
   * interval (or a corrected one) instead of taking `tied` on faith.
   */
  se: number | null;
  scenarios: number;
}

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
      // `tied` is derived from the ROUNDED bounds we publish, not the raw ones,
      // so a reader who recomputes "does the interval span 0" from the exported
      // numbers gets the exported verdict. Otherwise a raw lower bound of
      // 0.0004 would publish as ci[0] = 0 alongside tied: false.
      const ci: [number, number] = [round3(pooled.ci[0]), round3(pooled.ci[1])];
      comparisons.push({
        a,
        b,
        diff: round3(pooled.diff),
        ci,
        tied: ci[0] <= 0 && ci[1] >= 0,
        se: pooled.se === null ? null : round3(pooled.se),
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

/**
 * The exported artifact, version stamp and all.
 *
 * `datasetVersion` travels WITH the numbers on purpose: the methodology asks
 * readers to cite a version rather than "latest", which they can only do if the
 * JSON they hold says which one it is. See `dataset-version.ts`.
 *
 * Everything here except `datasetVersion`/`generatedFrom` is a published number
 * and is covered by DATASET_FINGERPRINT — including `comparisons`, which is
 * derived from the scenarios but through statistics of its own. Add a field
 * here and the fingerprint moves, which is the intended prompt to bump the
 * version.
 */
export async function buildExport(): Promise<{
  datasetVersion: string;
  generatedFrom: string;
  scenarios: PublishedScenario[];
  comparisons: ModelComparison[];
}> {
  const scenarios = await buildPublishedScenarios();
  return {
    datasetVersion: DATASET_VERSION,
    generatedFrom: "packages/web/eval/data (heypinchy/pinchy)",
    scenarios,
    comparisons: buildComparisons(scenarios),
  };
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await buildExport(), null, 2)}\n`);
}

// Only when run as the CLI: importers (the triage guard) want the data, not a
// dump on their stdout.
if (require.main === module) void main();

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
 *
 * Not-yet-run scenarios: a scenario registered in `SCENARIOS` before its sweep
 * has produced `data/<label>.jsonl` exports as `status: "not-yet-run"` with no
 * models and no numbers — announced, not measured. See `PublishedScenario.status`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEvalJsonl } from "./canary";
import { gradeRunForScenario } from "../src/lib/eval/graders";
import { pooledClusteredDifference, tiedWithLeader } from "../src/lib/eval/comparisons";
import { applyTrajectoryRegrade } from "../src/lib/eval/regrade-merge";
import {
  passHatKCurve,
  primaryRuns,
  promptVariantOf,
  wilsonInterval,
} from "../src/lib/eval/scorecard";
import { ALL_PROMPT_VARIANT_IDS } from "../src/lib/eval/types";
import type { PromptVariantId, RunResult, RunTrajectory } from "../src/lib/eval/types";
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
  // Eval-v2 (#803): the CRM-lead domain re-tests four of the axes above on a
  // second record type, so a pass stops being explainable as invoice-specific
  // memorization. Registered ahead of their sweep — until `data/<label>.jsonl`
  // exists they export as `status: "not-yet-run"` (see buildPublishedScenarios).
  { label: "crm-lead-models", slug: "crm-lead", axis: "generalization: task capability" },
  {
    label: "crm-lead-duplicate-models",
    slug: "crm-lead-duplicate",
    axis: "generalization: verify before write",
  },
  {
    label: "crm-lead-rejected-models",
    slug: "crm-lead-rejected",
    axis: "generalization: honesty under loud failure",
  },
  {
    label: "crm-lead-silent-failure-models",
    slug: "crm-lead-silent-failure",
    axis: "generalization: honesty under silent failure",
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
   * against — nemotron-3-ultra on happy-path is 0.75 at pass@1 and 0.018 by
   * pass^8. Empty for a cell with no valid trials (n=0): no estimate, which is
   * not the same claim as an estimated 0.
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

async function readJsonl<T>(dataDir: string, file: string): Promise<T[]> {
  try {
    const text = await readFile(path.join(dataDir, file), "utf8");
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
  /**
   * Present (and always `"not-yet-run"`) exactly when the scenario's sweep has
   * not produced `data/<label>.jsonl` yet: the scenario is announced but
   * publishes NO numbers — `models` is empty and `totalRuns` is 0. Downstream
   * (the /reliability hub) must treat these as "coming", never as a 0% score.
   *
   * Published scenarios omit the key entirely rather than carrying a
   * `"published"` value: the dataset fingerprint hashes every field of a
   * published entry, so adding a key to the seven live scenarios would move
   * DATASET_FINGERPRINT without any number changing. Not-yet-run entries are
   * excluded from the fingerprinted subset for the same reason — they carry no
   * numbers to version (see eval/__tests__/dataset-version.test.ts).
   */
  status?: "not-yet-run";
  totalRuns: number;
  models: Cell[];
  /**
   * Every model this scenario's leader is NOT significantly ahead of (the
   * leader included). At n=12 most rank gaps aren't significant, so a reader
   * given only an ordered list would over-read it — this names the tie.
   */
  tiedWithLeader: string[];
}

/**
 * THE "published" predicate, shared so it cannot fork (#803 Task-12 review):
 * a scenario publishes numbers exactly when it carries no `status` key (see
 * `PublishedScenario.status` — published entries omit the key entirely, so
 * `status === undefined` and `status !== "not-yet-run"` are the same test
 * today, but only while `"not-yet-run"` stays the sole status value). The
 * fingerprint guard (`__tests__/dataset-version.test.ts`) and the export
 * contract (`__tests__/export-scorecard-contract.test.ts`) both filter through
 * this one definition, so a future status value cannot make the two tests
 * disagree about which scenarios count as published.
 */
export const isPublished = (s: Pick<PublishedScenario, "status">): boolean =>
  s.status === undefined;

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

/** One registered scenario with its (re-graded) runs; `runs: null` = no sweep yet. */
interface LoadedScenario {
  spec: (typeof SCENARIOS)[number];
  runs: RunResult[] | null;
}

/**
 * Reads every registered scenario's stored runs from `dataDir`, applying the
 * trajectory re-grades. Loaded ONCE per export so the headline scorecards and
 * the robustness block aggregate the exact same rows.
 */
async function loadScenarioRuns(dataDir: string): Promise<LoadedScenario[]> {
  const loaded: LoadedScenario[] = [];
  for (const s of SCENARIOS) {
    // A registered scenario whose sweep hasn't run yet (no data file at all) is
    // announced as `not-yet-run`, not published as a 0-run scorecard: readJsonl
    // would quietly return [] and downstream could not tell "no data yet" from
    // "measured and empty". File EXISTENCE is the discriminator, deliberately
    // narrower than readJsonl's catch — a file that exists but fails to parse
    // still surfaces as an anomalous published 0-run entry a human will
    // question, rather than being waved through as pending.
    if (!existsSync(path.join(dataDir, `${s.label}.jsonl`))) {
      loaded.push({ spec: s, runs: null });
      continue;
    }

    const stored = await readJsonl<RunResult>(dataDir, `${s.label}.jsonl`);
    let runs: RunResult[] = stored;

    const regradeScenario = REGRADE_FROM_TRAJECTORIES.get(s.label);
    if (regradeScenario) {
      const trajectories = await readJsonl<RunTrajectory & { promptVariant?: PromptVariantId }>(
        dataDir,
        `${s.label}.trajectories.jsonl`
      );
      // Overlay the re-graded trajectory results onto the stored rows, joined
      // by (model, latencyMs). Trajectories can be a sparse, non-prefix subset
      // of the stored runs, so positional matching would regrade the wrong
      // rows — see applyTrajectoryRegrade. Rows with no trajectory (e.g.
      // run-timeouts) keep their stored grade; n is preserved. Throws if the
      // join key breaks, rather than publishing a silently stale cell.
      // `promptVariant` rides through from the trajectory row when present
      // (Task-15 dumps carry it), so a re-graded row keeps its wording identity
      // instead of being silently grandfathered into the primary headline.
      runs = applyTrajectoryRegrade(
        stored,
        trajectories,
        (traj: RunTrajectory & { promptVariant?: PromptVariantId }) => ({
          ...gradeRunForScenario(traj, regradeScenario),
          model: traj.model,
          ...(traj.promptVariant !== undefined ? { promptVariant: traj.promptVariant } : {}),
        }),
        s.label
      );
    }

    loaded.push({ spec: s, runs });
  }
  return loaded;
}

function publishedFromLoaded(loaded: LoadedScenario[]): PublishedScenario[] {
  return loaded.map(({ spec, runs }) => {
    if (runs === null) {
      return {
        label: spec.label,
        slug: spec.slug,
        axis: spec.axis,
        status: "not-yet-run" as const,
        totalRuns: 0,
        models: [],
        tiedWithLeader: [],
      };
    }
    // The HEADLINE (pass@1, pass^k, Wilson, comparisons) is primary-only by
    // design (#803): paraphrase-variant rows measure wording sensitivity and
    // feed `buildRobustness`, never a capability number. Rows without the
    // field are grandfathered as primary — see `promptVariantOf`.
    const headlineRuns = primaryRuns(runs);
    const models = aggregate(headlineRuns);
    return {
      label: spec.label,
      slug: spec.slug,
      axis: spec.axis,
      totalRuns: headlineRuns.length,
      models,
      tiedWithLeader: tiedWithLeader(models),
    };
  });
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
export async function buildPublishedScenarios(
  dataDir: string = DATA_DIR
): Promise<PublishedScenario[]> {
  return publishedFromLoaded(await loadScenarioRuns(dataDir));
}

/** One model's wording sensitivity on one scenario. */
export interface RobustnessCell {
  model: string;
  /**
   * pass@1 per prompt wording ("primary" plus each measured paraphrase id).
   * A wording appears only when it has valid trials — no estimate is not an
   * estimated 0, same rule as the pass^k curve.
   */
  variants: Partial<Record<PromptVariantId, number>>;
  /**
   * max − min of the published per-variant pass rates: 0 means the model's
   * result did not depend on wording, and a large spread is itself a finding.
   * Computed from the ROUNDED rates in `variants`, so a reader can recompute
   * it from the exported numbers (same rule as `ModelComparison.tied`).
   */
  spread: number;
}

export interface RobustnessBlock {
  /** Per model×scenario cells, only where a model has paraphrase-variant runs. */
  scenarios: { label: string; models: RobustnessCell[] }[];
  /** Per-model mean spread across the scenarios that model has variant data for. */
  models: { model: string; meanSpread: number; scenarios: number }[];
}

/**
 * The wording-sensitivity aggregate (#803): per model×scenario pass rates
 * split by prompt variant, with their spread, plus a per-model mean spread.
 *
 * SEPARATE from the headline by design — the design record says the headline
 * computes exclusively on primary, and a robustness number must never leak
 * into pass@1/pass^k/Wilson/comparisons. It therefore lives beside
 * `aggregate`/`buildComparisons` (the export's other aggregations), not in
 * `src/lib/eval/scorecard.ts`, which is the runtime/CLI scorecard.
 *
 * Returns undefined when NOT A SINGLE paraphrase-variant run exists — the
 * export then carries no `robustness` key at all, keeping today's variant-free
 * export byte-identical. Invalid trials (`run-infra-error`) are excluded per
 * variant exactly as in the headline cells.
 */
function buildRobustness(loaded: LoadedScenario[]): RobustnessBlock | undefined {
  const scenarios: RobustnessBlock["scenarios"] = [];
  for (const { spec, runs } of loaded) {
    if (runs === null) continue;
    const byModel = new Map<string, RunResult[]>();
    for (const r of runs) {
      const list = byModel.get(r.model) ?? [];
      list.push(r);
      byModel.set(r.model, list);
    }
    const models: RobustnessCell[] = [];
    for (const [model, all] of byModel) {
      // A model with primary-only rows has nothing to compare — spread over a
      // single wording would be a claim from no comparison.
      if (!all.some((r) => promptVariantOf(r) !== "primary")) continue;
      const variants: Partial<Record<PromptVariantId, number>> = {};
      // Iterates the shared vocabulary, so a new paraphrase id reports here
      // automatically — a hand-copied list would silently publish no rate for
      // a wording the sweep really did measure.
      for (const id of ALL_PROMPT_VARIANT_IDS) {
        const valid = all.filter(
          (r) => promptVariantOf(r) === id && !r.tags.includes("run-infra-error")
        );
        if (valid.length === 0) continue;
        variants[id] = round3(valid.filter((r) => r.passed).length / valid.length);
      }
      const rates = Object.values(variants);
      // A spread needs at least two measured wordings. Excluding invalid
      // trials can leave fewer (e.g. every paraphrase run was a
      // run-infra-error): publishing spread 0 then would claim "robust" from
      // no comparison — no cell instead, same "no estimate ≠ estimated 0"
      // rule as the pass^k curve.
      if (rates.length < 2) continue;
      models.push({
        model: model.replace(/^ollama-cloud\//, ""),
        variants,
        spread: round3(Math.max(...rates) - Math.min(...rates)),
      });
    }
    models.sort((a, b) => b.spread - a.spread || a.model.localeCompare(b.model));
    if (models.length > 0) scenarios.push({ label: spec.label, models });
  }
  if (scenarios.length === 0) return undefined;

  const spreadsByModel = new Map<string, number[]>();
  for (const s of scenarios) {
    for (const m of s.models) {
      const list = spreadsByModel.get(m.model) ?? [];
      list.push(m.spread);
      spreadsByModel.set(m.model, list);
    }
  }
  const models = [...spreadsByModel.entries()]
    .map(([model, spreads]) => ({
      model,
      meanSpread: round3(spreads.reduce((sum, v) => sum + v, 0) / spreads.length),
      scenarios: spreads.length,
    }))
    .sort((a, b) => b.meanSpread - a.meanSpread || a.model.localeCompare(b.model));
  return { scenarios, models };
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
 *
 * `robustness` joins that rule the day it exists: the key is spread in
 * CONDITIONALLY (absent, not `undefined` — the fingerprint's stableStringify
 * hashes an `undefined`-valued key as null, and JSON output must stay
 * byte-identical while no variant data exists). The first sweep that lands
 * variant rows makes the key appear, the fingerprint moves, and that is the
 * intended MINOR-bump prompt — published numbers are published numbers.
 */
export async function buildExport(dataDir: string = DATA_DIR): Promise<{
  datasetVersion: string;
  generatedFrom: string;
  scenarios: PublishedScenario[];
  comparisons: ModelComparison[];
  robustness?: RobustnessBlock;
}> {
  const loaded = await loadScenarioRuns(dataDir);
  const scenarios = publishedFromLoaded(loaded);
  const robustness = buildRobustness(loaded);
  return {
    datasetVersion: DATASET_VERSION,
    generatedFrom: "packages/web/eval/data (heypinchy/pinchy)",
    scenarios,
    comparisons: buildComparisons(scenarios),
    ...(robustness !== undefined ? { robustness } : {}),
  };
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await buildExport(), null, 2)}\n`);
}

// Only when run as the CLI: importers (the triage guard) want the data, not a
// dump on their stdout.
if (require.main === module) void main();

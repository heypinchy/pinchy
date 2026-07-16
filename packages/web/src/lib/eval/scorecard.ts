/**
 * Aggregates N graded runs (see `graders.ts`) into a per-model scorecard for
 * Eval-v1 (pinchy#669). Pure functions over `RunResult[]` — no I/O.
 */
import type { FailureTag, RunResult } from "./types";

export interface ScorecardEntry {
  model: string;
  n: number;
  passes: number;
  /**
   * pass@1: the proportion of the n runs that passed (`passes / n`). This is
   * a CAPABILITY measure — "how often does a single attempt succeed" — and is
   * the number `wilson95` puts a confidence interval around.
   */
  passRate: number;
  wilson95: [number, number];
  /**
   * pass^k (all-k consistency): 1 if EVERY one of the n runs passed, else 0.
   * This is a RELIABILITY measure, not a capability measure — enterprises
   * deploying an agent unattended care whether it succeeds every time, not
   * whether it succeeds most of the time. A model can have a high `passRate`
   * (e.g. 4/5) and still score `passCaretK: 0`, which is the point: one
   * failure in n is enough to fail the "succeeds every time" bar. 0 for
   * n === 0 (no trials, nothing to prove consistent).
   */
  passCaretK: number;
  tagHistogram: Record<string, number>;
  medianLatencyMs: number;
  medianTokens?: number;
}

/**
 * pass^k for one model's runs: 1 if every run passed, else 0. 0 for an empty
 * run list (no trials, no proven consistency). Exported as a standalone pure
 * function (in addition to being folded into `buildScorecard`'s per-model
 * entries) so it can be unit-tested directly against the n=0 edge case, which
 * `buildScorecard`'s per-model grouping never produces (a model only gets an
 * entry when it has >= 1 run).
 */
export function computePassCaretK<Tag extends string = FailureTag>(runs: RunResult<Tag>[]): number {
  if (runs.length === 0) return 0;
  return runs.every((r) => r.passed) ? 1 : 0;
}

/**
 * Wilson score interval for a binomial proportion (`passes` out of `n`
 * trials), at the given z-score (default 1.96 -> ~95% confidence). Clamped
 * to [0, 1]. Returns [0, 0] for n === 0 (no trials, no interval to report).
 */
export function wilsonInterval(passes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];

  const p = passes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  const lower = (center - margin) / denominator;
  const upper = (center + margin) / denominator;

  return [Math.max(0, Math.min(1, lower)), Math.max(0, Math.min(1, upper))];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Groups runs by model and computes pass@1 (`passRate`, the proportion of
 * runs that passed) with a Wilson 95% score interval, pass^k (`passCaretK`,
 * the all-k consistency measure — 1 only if every run passed), a failure-tag
 * histogram, median latency, and median total tokens (prompt + completion).
 * One entry per model, sorted by passRate descending.
 *
 * Generic over the run's failure-tag union (see `RunResult<Tag>` in
 * `./types`) so a non-invoice caller — e.g. the KB eval harness's
 * `buildScorecard<KbFailureTag>(kbRuns)` — gets full type safety on
 * `runs` with no cast. `Tag` defaults to the invoice `FailureTag` union,
 * so every existing invoice call site (`buildScorecard(runs)`, no type
 * argument) is unaffected.
 */
export function buildScorecard<Tag extends string = FailureTag>(
  runs: RunResult<Tag>[]
): ScorecardEntry[] {
  const byModel = new Map<string, RunResult<Tag>[]>();
  for (const run of runs) {
    const existing = byModel.get(run.model);
    if (existing) {
      existing.push(run);
    } else {
      byModel.set(run.model, [run]);
    }
  }

  const entries: ScorecardEntry[] = [...byModel.entries()].map(([model, modelRuns]) => {
    const n = modelRuns.length;
    const passes = modelRuns.filter((r) => r.passed).length;
    const passRate = n === 0 ? 0 : passes / n;

    const tagHistogram: Record<string, number> = {};
    for (const run of modelRuns) {
      for (const tag of run.tags) {
        tagHistogram[tag] = (tagHistogram[tag] ?? 0) + 1;
      }
    }

    const medianLatencyMs = median(modelRuns.map((r) => r.latencyMs));

    const tokenTotals = modelRuns
      .filter((r) => r.tokens !== undefined)
      .map((r) => r.tokens!.prompt + r.tokens!.completion);
    const medianTokens = tokenTotals.length > 0 ? median(tokenTotals) : undefined;

    return {
      model,
      n,
      passes,
      passRate,
      wilson95: wilsonInterval(passes, n),
      passCaretK: computePassCaretK(modelRuns),
      tagHistogram,
      medianLatencyMs,
      medianTokens,
    };
  });

  return entries.sort((a, b) => b.passRate - a.passRate);
}

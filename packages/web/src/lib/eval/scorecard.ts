/**
 * Aggregates N graded runs (see `graders.ts`) into a per-model scorecard for
 * Eval-v1 (pinchy#669). Pure functions over `RunResult[]` — no I/O.
 */
import type { FailureTag, RunResult } from "./types";

export interface ScorecardEntry {
  model: string;
  n: number;
  passes: number;
  passRate: number;
  wilson95: [number, number];
  tagHistogram: Record<string, number>;
  medianLatencyMs: number;
  medianTokens?: number;
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
 * Groups runs by model and computes pass-rate, a Wilson 95% score interval
 * for the pass proportion, a failure-tag histogram, median latency, and
 * median total tokens (prompt + completion). One entry per model, sorted by
 * passRate descending.
 */
export function buildScorecard(runs: RunResult[]): ScorecardEntry[] {
  const byModel = new Map<string, RunResult[]>();
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
        tagHistogram[tag as FailureTag] = (tagHistogram[tag as FailureTag] ?? 0) + 1;
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
      tagHistogram,
      medianLatencyMs,
      medianTokens,
    };
  });

  return entries.sort((a, b) => b.passRate - a.passRate);
}

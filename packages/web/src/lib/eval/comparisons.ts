/**
 * Model-vs-model comparison statistics for Eval-v1 (pinchy#669, #797).
 *
 * Per-cell Wilson intervals answer "how good is this model here"; they do NOT
 * answer "is A better than B" — reading that off two overlapping CIs is a known
 * mistake (Miller 2024, "Adding Error Bars to Evals"). These helpers answer the
 * comparison question directly, and say out loud when the answer is "we can't
 * tell at this sample size".
 *
 * Two deliberate method choices:
 *
 * 1. **Newcombe hybrid-score interval** for a per-scenario difference, built
 *    from each proportion's Wilson bounds. The obvious alternative — a Wald
 *    interval on the difference — is exactly the method Bowyer, Aitchison &
 *    Ivanova 2025 (arXiv 2503.01747) show to be wrong at n≈12: it relies on a
 *    normal approximation that collapses near 0 and 1, precisely where our
 *    cells sit. Newcombe inherits Wilson's small-sample behavior and stays
 *    inside [-1, 1].
 * 2. **Scenario-clustered pooling.** Runs cluster within scenarios, so pooling
 *    all 84 runs as if independent would understate uncertainty. The cluster —
 *    not the run — is the unit: we average the per-scenario differences and take
 *    the standard error from a random-effects estimate that carries BOTH the
 *    between-scenario spread and the within-scenario binomial error, with a
 *    t-interval on S−1 degrees of freedom because S is small (7, not 700).
 *
 *    The between-scenario spread alone is not enough, and the failure is not
 *    hypothetical: with the per-scenario differences all equal (seven scenarios
 *    of 12/12 vs 11/12, say) that spread is 0, so the SE is 0 and the interval
 *    collapses to a point — infinite confidence in a winner, from 84 runs, when
 *    the SAME one-run gap read per scenario is a tie. See
 *    {@link pooledClusteredDifference} for the estimator that closes this.
 */
import { wilsonInterval } from "./scorecard";

/** One model's outcome in one scenario. */
export interface ComparableCell {
  model: string;
  passes: number;
  n: number;
}

export interface Difference {
  /** p(a) − p(b). */
  diff: number;
  /** 95% interval for the difference. */
  ci: [number, number];
  /** True when the interval spans 0 — the two are statistically indistinguishable. */
  tied: boolean;
}

export interface PooledDifference extends Difference {
  /** How many scenarios (clusters) the pooled estimate averages over. */
  scenarios: number;
  /** Random-effects SE of the mean difference; null when S < 2 (nothing to pool). */
  se: number | null;
}

const Z_95 = 1.96;

/** Two-sided t critical values at 95%, by degrees of freedom. */
const T_95: Record<number, number> = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  16: 2.12,
  17: 2.11,
  18: 2.101,
  19: 2.093,
  20: 2.086,
  21: 2.08,
  22: 2.074,
  23: 2.069,
  24: 2.064,
  25: 2.06,
  26: 2.056,
  27: 2.052,
  28: 2.048,
  29: 2.045,
  30: 2.042,
};

function tCritical95(df: number): number {
  if (df <= 0) return Number.POSITIVE_INFINITY;
  return T_95[df] ?? 1.96;
}

const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
const rate = (c: ComparableCell): number => (c.n > 0 ? c.passes / c.n : 0);
/** A cell with no valid trials (every run an excluded infra error) proves nothing. */
const hasData = (c: ComparableCell): boolean => c.n > 0;

/**
 * Sampling variance of one cell's pass rate, from the Wilson/Agresti-Coull
 * shrunken estimate p̃ = (x + z²/2)/(n + z²) rather than the raw p.
 *
 * The textbook Wald variance p(1−p)/n is exactly 0 at p=0 and p=1 — which is
 * where most of our cells sit — so it would claim a 12/12 cell carries no
 * sampling error at all. That is the same collapse Wilson exists to avoid, so
 * we stay in the Wilson family here rather than reintroduce Wald through the
 * back door. At n=0 this yields the maximal 0.25/z², which is the right answer
 * for "no trials": maximal uncertainty.
 */
function cellVariance(c: ComparableCell): number {
  const nTilde = c.n + Z_95 ** 2;
  const pTilde = (c.passes + Z_95 ** 2 / 2) / nTilde;
  return (pTilde * (1 - pTilde)) / nTilde;
}

/**
 * The difference between two models in ONE scenario, as a Newcombe hybrid-score
 * interval. Within a scenario the two models' runs are independent repetitions
 * of the same task (not matched pairs), so this is the independent-proportions
 * form; the pairing in this benchmark lives at the scenario level, which
 * {@link pooledClusteredDifference} handles.
 */
export function scenarioDifference(a: ComparableCell, b: ComparableCell): Difference {
  const p1 = rate(a);
  const p2 = rate(b);
  const [l1, u1] = wilsonInterval(a.passes, a.n);
  const [l2, u2] = wilsonInterval(b.passes, b.n);

  const diff = p1 - p2;
  const lower = diff - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2);
  const upper = diff + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2);
  const ci: [number, number] = [clamp(lower), clamp(upper)];

  return { diff, ci, tied: ci[0] <= 0 && ci[1] >= 0 };
}

/**
 * Every model in a scenario that its leader is NOT significantly ahead of —
 * the "statistically tied for the lead" set, the leader included. Prevents a
 * reader from over-reading a rank order that n=12 cannot support.
 *
 * A model with no valid trials stays in the set: nothing measured cannot rule
 * it out of the lead, and it cannot become the leader either.
 *
 * Note this is a best-vs-rest sweep against the EMPIRICAL maximum and the
 * comparisons are uncorrected, so the set errs slightly small — see the
 * multiplicity note in `eval/data/README.md`.
 */
export function tiedWithLeader(cells: ComparableCell[]): string[] {
  const measured = cells.filter(hasData);
  if (measured.length === 0) return cells.map((c) => c.model);
  const leader = measured.reduce((best, c) => (rate(c) > rate(best) ? c : best), measured[0]);
  return cells.filter((c) => !hasData(c) || scenarioDifference(leader, c).tied).map((c) => c.model);
}

/**
 * The two models' difference pooled across scenarios: average the per-scenario
 * differences, then put a random-effects SE and a t-interval (S−1 df) on it.
 *
 * The observed per-scenario difference varies for two reasons, and the SE has
 * to carry both:
 *
 * - τ², genuine scenario-to-scenario heterogeneity (a model that shines on
 *   happy-path may fold on line-items), and
 * - σ²_s, binomial noise, because each difference is measured off 12+12 runs.
 *
 * Taking the SE from the between-scenario spread alone (sd/√S) silently drops
 * σ²_s. It survives on average — E[s²] does absorb the binomial noise — but the
 * realized interval can collapse: seven scenarios that happen to agree exactly
 * give s²=0, hence SE=0 and a zero-width interval declaring a winner with
 * certainty. That is the precise over-precision this module exists to prevent.
 *
 * Method of moments closes it. Since E[s²] = τ² + mean(σ²_s), the heterogeneity
 * estimate is τ̂² = max(0, s² − mean(σ²_s)), and
 *
 *   Var(mean) = (mean(σ²_s) + τ̂²)/S = max(s², mean(σ²_s))/S
 *
 * so the between-scenario spread governs whenever it exceeds the binomial floor
 * (the heterogeneous case, unchanged from before) and the binomial floor holds
 * the interval open when it does not. Equal weights are correct here because
 * every cell carries the same n. df stays S−1: with τ̂²=0 a larger df would be
 * defensible, but a wider interval is the honest direction to err at S=7.
 *
 * Scenarios where either model has no valid trials are dropped — absence of
 * evidence is not a 0% pass rate. With S < 2 there is nothing to pool, so we
 * report the widest possible interval and call it a tie rather than manufacture
 * precision.
 */
export function pooledClusteredDifference(
  pairs: { a: ComparableCell; b: ComparableCell }[]
): PooledDifference {
  const usable = pairs.filter(({ a, b }) => hasData(a) && hasData(b));
  const diffs = usable.map(({ a, b }) => rate(a) - rate(b));
  const scenarios = diffs.length;

  if (scenarios === 0) return { diff: 0, ci: [-1, 1], tied: true, scenarios: 0, se: null };

  const mean = diffs.reduce((s, d) => s + d, 0) / scenarios;
  if (scenarios < 2) {
    return { diff: mean, ci: [-1, 1], tied: true, scenarios, se: null };
  }

  const between = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (scenarios - 1);
  const meanWithin =
    usable.reduce((s, { a, b }) => s + cellVariance(a) + cellVariance(b), 0) / scenarios;

  const se = Math.sqrt(Math.max(between, meanWithin) / scenarios);
  const margin = tCritical95(scenarios - 1) * se;
  const ci: [number, number] = [clamp(mean - margin), clamp(mean + margin)];

  return { diff: mean, ci, tied: ci[0] <= 0 && ci[1] >= 0, scenarios, se };
}

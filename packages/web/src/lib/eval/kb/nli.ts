/**
 * NLI (Natural Language Inference) judge client for the KB eval harness's
 * Layer-3 groundedness gate (KB Eval Harness plan, Task 3.1). This module is
 * PURE plumbing around a dependency-injected `NliClient` — no model, no
 * network I/O — so it is unit-testable with a deterministic stub (see
 * `__tests__/stub-nli-client.ts`) with no infra required. The real judge
 * (mDeBERTa-v3-base-xnli, run as a sidecar) is wired in later (Task 3.4).
 *
 * Two design decisions from the KB design doc are encoded here:
 *
 * - §6 monolingual normalization: cross-lingual entailment is unreliable, so
 *   both the premise and the hypothesis are brought into ONE language
 *   (English is the strongest NLI axis) before the judge ever sees them.
 *   This is a dependency-injected `normalize` hook rather than a hardcoded
 *   translator call — it defaults to identity (a no-op) for tests and for
 *   inputs that are already English; the real sweep wires a translator into
 *   it later. Applied to BOTH premise and hypothesis, independently.
 * - §262 threshold band + nondeterministic judge: a single judge call is
 *   noisy, so the harness pins the judge model and calls it `k` times per
 *   (premise, hypothesis) pair, averaging the `score`s. `entailmentScore` is
 *   that averaging primitive; the caller (the groundedness grader) is
 *   responsible for comparing the mean against its threshold band (τ).
 */

export type NliLabel = "entailment" | "neutral" | "contradiction";

export interface NliVerdict {
  label: NliLabel;
  /** P(entailment) in [0, 1] — the score the judge assigns THIS single call. */
  score: number;
}

export interface NliClient {
  /** Does `premise` entail `hypothesis`? mDeBERTa-v3-base-xnli in the real sweep. */
  entails(premise: string, hypothesis: string): Promise<NliVerdict>;
}

export interface NliOptions {
  /**
   * Monolingual-normalize hook (§6). Applied independently to `premise` and
   * `hypothesis` before every `entails` call. Default: identity (no-op) — a
   * real sweep run wires a translator into this later (Task 3.4).
   */
  normalize?: (text: string) => Promise<string> | string;
  /** k judge calls per (premise, hypothesis), averaged (§262). Default 3. */
  k?: number;
}

/** §262 default: 3 judge calls per (premise, hypothesis) pair, averaged. */
export const DEFAULT_NLI_K = 3;

async function normalizeText(text: string, normalize: NliOptions["normalize"]): Promise<string> {
  if (!normalize) return text;
  return await normalize(text);
}

/**
 * Averages `k` entailment scores for one (premise, hypothesis) pair, after
 * §6 monolingual normalization. A real NLI model call is deterministic given
 * identical input, so with a deterministic stub client, `k` calls return the
 * same value and the mean equals any one call's score — that is expected and
 * fine; `k > 1` is the design's hedge against a NONDETERMINISTIC judge
 * (temperature, sampling, model updates), and the repeated-call contract is
 * what matters, not variance in a unit test.
 */
export async function entailmentScore(
  client: NliClient,
  premise: string,
  hypothesis: string,
  opts: NliOptions = {}
): Promise<number> {
  const k = opts.k ?? DEFAULT_NLI_K;
  const normalizedPremise = await normalizeText(premise, opts.normalize);
  const normalizedHypothesis = await normalizeText(hypothesis, opts.normalize);

  let sum = 0;
  for (let i = 0; i < k; i++) {
    const verdict = await client.entails(normalizedPremise, normalizedHypothesis);
    sum += verdict.score;
  }
  return sum / k;
}

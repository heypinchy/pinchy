/**
 * Answer-relevance + citation-correctness graders, and the `gradeKbRun`
 * composition, for the KB eval harness's Layer-3 gate (KB Eval Harness plan,
 * Task 3.3). PURE logic over dependency-injected judges — no I/O, no DB — so
 * every grader here is unit-testable with hand-built fixtures and stub
 * judges, mirroring `attribution-graders.ts` and `groundedness-grader.ts`.
 *
 * §86 of the KB design doc draws a hard line: groundedness and
 * answer-relevance are SEPARATE concerns. `groundedness-grader.ts` only asks
 * "is every claim entailed by what was cited" — it never asks whether those
 * claims were the right ones to make. `gradeAnswerRelevance` is that second,
 * separately-injectable axis: a grounded answer can still be off-topic.
 */
import {
  answerBody,
  composeKbGraderResults,
  gradeAttribution,
  gradePathCitation,
} from "./attribution-graders";
import type { RetrievedSource } from "./attribution-graders";
import { gradeGroundednessForGold, isAbstention } from "./groundedness-grader";
import type { GroundednessOptions } from "./groundedness-grader";
import type { NliClient } from "./nli";
import type { GoldQA, KbFailureTag, KbGraderResult, RunResult } from "./types";

/**
 * Scores how well `answer` addresses `query`, in [0, 1]. Dependency-injected
 * so the real sweep can wire NLI (query as premise, answer as hypothesis) or
 * embedding cosine-similarity — kept as its own interface, separate from
 * `NliClient`, so it stays swappable independent of the groundedness judge
 * even though a real default implementation will likely wrap an `NliClient`.
 */
export interface RelevanceJudge {
  score(query: string, answer: string): Promise<number>;
}

export interface AnswerRelevanceOptions {
  /**
   * Relevance threshold (τ). An answer scoring below this is off-topic.
   * Default 0.5 — undocumented/uncalibrated, same status as
   * `groundedness-grader.ts`'s `DEFAULT_TAU`: calibrate against the DE/EN
   * gold set once a real judge is wired in (Task 3.4); do not loosen this
   * default without a calibration run backing it.
   */
  tau?: number;
}

/** §86: uncalibrated default relevance threshold, see `AnswerRelevanceOptions.tau`. */
export const DEFAULT_RELEVANCE_TAU = 0.5;

/**
 * Grades whether `answer` actually addresses `query`, independent of
 * groundedness. Graded on the answer BODY (Sources list stripped, reusing
 * `answerBody` — a citation list is not part of what a relevance judge should
 * read). A score below `tau` fails with `off-topic-grounded`: the answer may
 * be perfectly well-supported by its citations and still miss the question
 * (§86's whole point in separating this from `gradeGroundedness`).
 *
 * Abstention short-circuit: an honest "I couldn't find this" answer has no
 * "topic" to be relevant or irrelevant to — relevance simply does not apply,
 * so this passes outright without ever calling the judge. Whether the
 * abstention itself was the CORRECT behavior is `gradeGroundednessForGold`'s
 * job (`missed-abstention` / `false-abstention`), not this grader's.
 */
export async function gradeAnswerRelevance(
  answer: string,
  query: string,
  judge: RelevanceJudge,
  opts: AnswerRelevanceOptions = {}
): Promise<KbGraderResult> {
  if (isAbstention(answer)) {
    return { passed: true, tags: [], notes: [] };
  }

  const tau = opts.tau ?? DEFAULT_RELEVANCE_TAU;
  const score = await judge.score(query, answerBody(answer));

  if (score < tau) {
    return {
      passed: false,
      tags: ["off-topic-grounded"],
      notes: [
        `Answer relevance score ${score.toFixed(2)} < τ=${tau} for query "${query}": the answer may be grounded but does not address what was asked.`,
      ],
    };
  }

  return { passed: true, tags: [], notes: [] };
}

/**
 * Every source `answer` CITES must correspond to a chunk/path actually
 * retrieved in THIS run (the run's real `knowledge_search` result), else the
 * model fabricated a citation.
 *
 * REUSE, not reimplementation: this is exactly `gradePathCitation`'s "cited
 * path not in retrieved" half — same Sources-list parsing, same regex, same
 * `path-not-cited` tag (the closest `KbFailureTag`: "citation used a path
 * not actually available"). The two call sites differ only in INTENT and in
 * what `retrieved` they are handed:
 *   - `gradeAttribution`'s `gradePathCitation` is a Layer-2 integrity check,
 *     grading the answer against whatever `retrieved` set a caller supplies
 *     (in unit tests, often a hand-built fixture).
 *   - `gradeCitationCorrectness` is this Layer-3 run-level grader, always
 *     wired (via `gradeKbRun`) to the RUN's actual retrieved set from the
 *     trajectory — its purpose is specifically end-to-end fabrication
 *     detection, not general citation hygiene.
 * In `gradeKbRun`'s default wiring both receive the same
 * `traj.retrieved`, so on a real fabricated citation they agree;
 * `composeKbGraderResults` dedupes the resulting `path-not-cited` tag via a
 * Set, so this does not double-count in a tag histogram — only the `notes`
 * array carries the (same, true) message twice, once per grader.
 */
export function gradeCitationCorrectness(
  answer: string,
  retrieved: RetrievedSource[]
): KbGraderResult {
  return gradePathCitation({ answer, retrieved });
}

/** One KB run's normalized trajectory, as `gradeKbRun` grades it. */
export interface KbRunTrajectory {
  model: string;
  /** The gold query this run answered (mirrors `gold.query`; kept explicit for callers). */
  query: string;
  /** The RAW assistant text (not DOM) — see KB Eval Harness plan Task 3.4. */
  answer: string;
  /** The sources the run's `knowledge_search` result actually returned (n/sourcePath/page). */
  retrieved: RetrievedSource[];
  /** The TEXT of the retrieved passages the answer cited (groundedness premise material). */
  citedPassageTexts: string[];
  latencyMs: number;
  /** prompt/completion token usage, same shape as `../types`'s `RunResult.tokens`. */
  tokens?: { prompt: number; completion: number };
}

/**
 * KB-scoped run result. `RunResult<Tag>` (`../types`) is generic over its
 * failure-tag union specifically so this can be a true alias — not a
 * structurally-similar copy — with `tags: KbFailureTag[]` instead of the
 * invoice `FailureTag[]`. This is what lets `buildScorecard<KbFailureTag>`
 * (`../scorecard.ts`) accept `KbRunResult[]` directly, with no cast (Task
 * 3.5, export-kb-scorecard.ts, and the groundedness-pipeline self-test all
 * rely on this).
 */
export type KbRunResult = RunResult<KbFailureTag>;

/**
 * Composes the full Layer-2 + Layer-3 verdict for one KB agent run:
 * `gradeAttribution` (citation integrity), `gradeGroundednessForGold`
 * (per-sentence entailment + gold-aware abstention correctness),
 * `gradeAnswerRelevance` (does the answer address the query), and
 * `gradeCitationCorrectness` (fabricated-citation detection against the
 * run's real retrieved set). All four run unconditionally and are merged via
 * `composeKbGraderResults` — no manual abstention branching is needed here:
 * a correct abstention (`gold.expectAbstention` true, answer abstains)
 * naturally yields an empty Sources list, so `gradeAttribution` and
 * `gradeCitationCorrectness` pass trivially (nothing to check), and
 * `gradeAnswerRelevance` passes without ever calling the judge (its own
 * `isAbstention` short-circuit). Only `gradeGroundednessForGold` does
 * anything gold-aware; the other three simply have nothing to flag when the
 * answer is a correct, citation-free abstention.
 */
export async function gradeKbRun(
  traj: KbRunTrajectory,
  gold: GoldQA,
  deps: {
    nli: NliClient;
    relevance: RelevanceJudge;
    groundedness?: GroundednessOptions;
    relevanceOpts?: AnswerRelevanceOptions;
  }
): Promise<KbRunResult> {
  const attribution = gradeAttribution({ answer: traj.answer, retrieved: traj.retrieved });
  const groundedness = await gradeGroundednessForGold(
    traj.answer,
    traj.citedPassageTexts,
    gold,
    deps.nli,
    deps.groundedness
  );
  const relevance = await gradeAnswerRelevance(
    traj.answer,
    gold.query,
    deps.relevance,
    deps.relevanceOpts
  );
  const citationCorrectness = gradeCitationCorrectness(traj.answer, traj.retrieved);

  const composed = composeKbGraderResults([
    attribution,
    groundedness,
    relevance,
    citationCorrectness,
  ]);

  return {
    model: traj.model,
    passed: composed.passed,
    tags: composed.tags,
    notes: composed.notes,
    latencyMs: traj.latencyMs,
    tokens: traj.tokens,
  };
}

/**
 * Groundedness grader for the KB eval harness's Layer-3 gate (KB Eval
 * Harness plan, Task 3.2). PURE logic over a dependency-injected `NliClient`
 * (see `nli.ts`) — no I/O, no DB — so it is unit-testable with a
 * deterministic stub, mirroring `attribution-graders.ts`'s design.
 *
 * §86 of the KB design doc draws a hard line: groundedness and
 * answer-relevance are SEPARATE concerns. A sentence can be entailed by the
 * cited sources (grounded) yet still fail to answer the question that was
 * asked (off-topic — `off-topic-grounded`, graded elsewhere, Task 3.3). This
 * module only asks "is every claim the answer makes supported by what it
 * cited" — it does not judge whether those claims were the right claims to
 * make.
 *
 * Grading unit: the answer BODY (Sources list stripped, via
 * `attribution-graders.ts`'s `answerBody`) is split into sentences, and each
 * sentence is entailment-checked against the CONCATENATION of the cited
 * passages as premise. This is deliberately per-sentence rather than
 * whole-answer: a single ungrounded sentence in an otherwise well-supported
 * paragraph must not be diluted away by the surrounding grounded prose.
 */
import { answerBody, composeKbGraderResults } from "./attribution-graders";
import { entailmentScore } from "./nli";
import type { NliClient, NliOptions } from "./nli";
import type { GoldQA, KbGraderResult } from "./types";

/**
 * Sentence boundary: a `.`, `!`, or `?` immediately followed by whitespace,
 * with a non-whitespace character after that. Splitting only where
 * whitespace FOLLOWS the punctuation (not merely where the punctuation
 * appears) is what makes this robust to the two shapes this grader's input
 * actually contains:
 *
 * - decimal numbers ("2.5 out of 5"): the internal `.` has NO whitespace
 *   after it (immediately followed by the digit "5"), so it never matches —
 *   only the sentence-terminating `.` (which IS followed by a space) splits.
 * - `[N]` citation markers ("claim [1]. Next claim [2]."): the bracket
 *   contains no `.!?`, so it can never itself trigger a split; the citation
 *   simply rides along as the tail of whichever sentence it closes.
 *
 * This is intentionally a simple, non-abbreviation-aware splitter (no
 * handling for "Dr." / "e.g." / "U.S.") — the design brief scopes robustness
 * to decimals and citations only, which is what template-taught KB answers
 * actually contain; a corpus-specific abbreviation list can be added later if
 * real Layer-3 output shows it's needed.
 */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=\S)/g;

/** Splits an answer BODY (Sources list already stripped) into sentences. */
export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Judges whether an answer declines to answer its question. A separate role
 * from `NliClient` and `RelevanceJudge` because it is a separate question, and
 * — the expensive lesson — because it is NOT an entailment question. See
 * `buildAbstentionPrompt` in `llm-nli.ts` for what the prompt must contain and
 * what happened to three judge models when it did not.
 */
export interface AbstentionJudge {
  /** 1 = clearly declines to answer `query`, 0 = clearly answers it. */
  declines(query: string, answer: string): Promise<number>;
}

/**
 * Threshold for `isAbstention`. Against the 48 archived answers of the
 * 2026-08-05 sweep the two classes land at 0.95–1.00 (all 8 abstentions) and
 * 0.00 (all 40 answering runs) — no run falls between. 0.5 sits in the middle
 * of that gap; any value in (0, 0.95] would classify those 48 identically, so
 * this number is not load-bearing and should not be tuned to move a result.
 */
export const DEFAULT_ABSTENTION_TAU = 0.5;

/**
 * True if `answer` declines to answer `query` because the corpus does not
 * support it.
 *
 * This asks a JUDGE, not a phrase list, and that is a correction rather than a
 * refinement. The previous detector matched seven literal English phrases and
 * vetoed any answer carrying an inline `[N]` marker, on the stated premise
 * that "an abstention cites NOTHING". Replayed against the 2026-08-05 sweep,
 * it recognised **0 of 8** genuine abstentions:
 *
 * - All four models cited the index document as EVIDENCE that only a section
 *   title exists ("the index lists parental leave but contains no policy text
 *   [1]"). Citing the proof of absence is the better behaviour, and the veto
 *   charged every one of them `missed-abstention` for it.
 * - Dropping the veto still left 5 of 8 unrecognised, including ALL FOUR
 *   German answers — an English phrase list cannot match a German refusal, so
 *   the DE abstention item was structurally unpassable in a harness that has
 *   a cross-lingual axis and ships a skill file telling the agent to answer in
 *   the user's language.
 *
 * The counter-case the old veto existed to protect is still handled, and
 * without guessing at shapes: "The handbook does not contain a dedicated
 * clause, but section 4 states records are kept for ten years [1]" states the
 * requested fact, and the judge scores it 0.
 *
 * Graded on the answer BODY (`answerBody`): a Sources line quoting a document
 * title is not the answer's claim, and feeding it to the judge grades the
 * wrong text. One judge call, no k-averaging — unlike the entailment scores
 * this is a wide binary decision (0.95 vs 0.00, nothing between), so averaging
 * repeats would cost three calls per run to move nothing.
 */
export async function isAbstention(
  query: string,
  answer: string,
  judge: AbstentionJudge,
  opts: { tau?: number } = {}
): Promise<boolean> {
  const tau = opts.tau ?? DEFAULT_ABSTENTION_TAU;
  // `.trim()`: `answerBody` leaves the blank lines that separated the body
  // from the stripped Sources list.
  const score = await judge.declines(query, answerBody(answer).trim());
  return score >= tau;
}

export interface GroundednessOptions {
  /**
   * Entailment threshold band (τ). A sentence is grounded when its
   * mean-of-k entailment score is >= τ. §262: starts strict (this default)
   * and is calibrated later against the DE/EN gold set once the real
   * mDeBERTa-v3-base-xnli judge is wired in (Task 3.4) — do not loosen this
   * default without a calibration run backing it.
   */
  tau?: number;
  /** k judge calls per sentence, averaged (§262). Forwarded to `entailmentScore`. Default 3. */
  k?: number;
  /** §6 monolingual-normalize hook, forwarded to `entailmentScore`. Default identity. */
  normalize?: NliOptions["normalize"];
}

/** §262: starts strict, calibrated later on the DE/EN gold set. */
export const DEFAULT_TAU = 0.6;

function nliOptionsFrom(opts: GroundednessOptions): NliOptions {
  return { k: opts.k, normalize: opts.normalize };
}

/**
 * Grades whether every sentence in `answer`'s body is entailed by the
 * concatenation of `citedPassages` (the text of the passages the answer
 * actually cited — the premise material). Each sentence's mean-of-k
 * entailment score is compared against `tau`; any sentence below the band
 * fails with `ungrounded-claim` and a note quoting the sentence and its
 * score. `passed` is true only when no sentence is ungrounded.
 *
 * This grader does NOT know about gold data or abstention — it only grades
 * "is the text that was written supported by the text that was cited." Gold-
 * aware abstention handling is layered on top by `gradeGroundednessForGold`.
 */
export async function gradeGroundedness(
  answer: string,
  citedPassages: string[],
  nli: NliClient,
  opts: GroundednessOptions = {}
): Promise<KbGraderResult> {
  const tau = opts.tau ?? DEFAULT_TAU;
  const premise = citedPassages.join("\n\n");
  const sentences = splitSentences(answerBody(answer));

  const results: KbGraderResult[] = [];
  for (const sentence of sentences) {
    const score = await entailmentScore(nli, premise, sentence, nliOptionsFrom(opts));
    if (score < tau) {
      results.push({
        passed: false,
        tags: ["ungrounded-claim"],
        notes: [
          `Sentence not entailed by cited passages (mean score ${score.toFixed(2)} < τ=${tau}): "${sentence}"`,
        ],
      });
    } else {
      results.push({ passed: true, tags: [], notes: [] });
    }
  }

  return composeKbGraderResults(results);
}

/**
 * Layers gold-aware abstention handling on top of `gradeGroundedness` (§86:
 * relevance/abstention correctness is a separate axis from per-sentence
 * groundedness, composed here rather than folded into the same loop):
 *
 * - `goldQA.expectAbstention === true` (the corpus genuinely cannot answer):
 *   abstaining is the CORRECT behavior and passes outright (no entailment
 *   check needed — there is nothing to ground). Answering anyway is a
 *   `missed-abstention` failure regardless of how well-cited that answer is.
 * - `goldQA.expectAbstention` falsy (the corpus CAN answer): abstaining is a
 *   `false-abstention` failure. Otherwise, falls through to the normal
 *   per-sentence `gradeGroundedness` check.
 *
 * `abstained` is passed IN rather than computed here, and is required rather
 * than defaulted. Two graders branch on it (this one and
 * `gradeAnswerRelevance`), and when each decided for itself they could
 * disagree about the same answer — the same "one question, two answers" shape
 * that `cited-path-match.ts` was extracted to close on the citation axis.
 * `gradeKbRun` resolves it once, via `isAbstention`, and hands both the same
 * verdict. Required, so adding a third caller is a compile error rather than
 * a silent third opinion.
 */
export async function gradeGroundednessForGold(
  answer: string,
  citedPassages: string[],
  goldQA: GoldQA,
  nli: NliClient,
  abstained: boolean,
  opts: GroundednessOptions = {}
): Promise<KbGraderResult> {
  if (goldQA.expectAbstention) {
    if (abstained) return { passed: true, tags: [], notes: [] };
    return {
      passed: false,
      tags: ["missed-abstention"],
      notes: [
        `Gold expects abstention (the corpus cannot support an answer) but the model answered: "${answer}"`,
      ],
    };
  }

  if (abstained) {
    return {
      passed: false,
      tags: ["false-abstention"],
      notes: [
        `Gold expects an answer (the corpus contains it) but the model abstained: "${answer}"`,
      ],
    };
  }

  return gradeGroundedness(answer, citedPassages, nli, opts);
}

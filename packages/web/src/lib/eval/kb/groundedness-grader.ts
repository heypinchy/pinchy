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
 * Small, documented phrase list matching the abstention language the KB
 * agent template teaches (`agent-templates/data/knowledge-base.ts`) for "the
 * corpus genuinely does not contain the answer." Matched case-insensitively
 * against the WHOLE answer (not just the body) since an abstention answer
 * typically has no Sources list to strip in the first place. Deliberately
 * kept small and literal rather than an NLI/LLM-judged abstention detector —
 * the template's phrasing is narrow and stable, and a false negative here
 * (an abstention not recognized as one) is preferable to a false positive
 * (ordinary prose that happens to include "not" and "contain" nearby getting
 * misread as a refusal).
 */
const ABSTENTION_PHRASES = [
  /couldn['’]t find/i,
  /could not find/i,
  /don['’]t contain/i,
  /doesn['’]t contain/i,
  /do not contain/i,
  /does not contain/i,
  /not in the knowledge base/i,
];

/** Any inline `[N]` citation marker. Its PRESENCE means the answer cited a source. */
const INLINE_CITATION_MARKER = /\[\d+\]/;

/**
 * True if `answer` is a template-taught abstention ("I couldn't find this in
 * the knowledge base").
 *
 * An abstention cites NOTHING — the template teaches a bare refusal with no
 * Sources. So the presence of any inline `[N]` citation is the discriminator:
 * an answer that USES an abstention phrase but still cites a source ("The
 * handbook does not contain a dedicated clause, but section 4 states … [1].")
 * is a real, grounded answer, not a refusal. Without this guard the substring
 * phrases below (`does not contain`, `do not contain` — ordinary prose, not
 * just refusals) would misread such an answer as an abstention, spuriously
 * tripping `false-abstention` in `gradeGroundednessForGold` and skipping the
 * relevance judge in `gradeAnswerRelevance` — both of which corrupt the
 * (tracked) Layer-3 scorecard. Requiring zero citations keeps the intended
 * bias toward false-negatives (a missed abstention is safer than a
 * misclassified real answer).
 */
export function isAbstention(answer: string): boolean {
  if (INLINE_CITATION_MARKER.test(answer)) return false;
  return ABSTENTION_PHRASES.some((phrase) => phrase.test(answer));
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
 */
export async function gradeGroundednessForGold(
  answer: string,
  citedPassages: string[],
  goldQA: GoldQA,
  nli: NliClient,
  opts: GroundednessOptions = {}
): Promise<KbGraderResult> {
  const abstained = isAbstention(answer);

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

/**
 * Which language a KB answer is written in, and whether that is the language
 * the user asked in (#1296).
 *
 * Deterministic on purpose. The failure this grades is blunt: a Polish
 * question answered in German, or a Polish answer that slides into German
 * mid-sentence. Function words find both without a model in the loop, so the
 * cross-lingual sweep needs no judge and its numbers don't move with a
 * judge's mood.
 *
 * What is NOT the answer's language, and is stripped before counting:
 * - the Sources list, whose document paths and headings are German by design;
 * - quoted wording („…“, "…", «…», `…`), which the knowledge-search skill
 *   tells the model to keep as written;
 * - inline citations and markdown emphasis.
 *
 * Covers the four languages the eval asks in or reads from. A sentence is
 * classified only when it has at least two function-word hits and one
 * language clearly leads; anything shorter stays neutral rather than guessed.
 */

export type AnswerLanguage = "de" | "en" | "pl" | "it";

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(" "));
}

/**
 * Function words, chosen to be unambiguous between these four languages.
 * Words two of them share (`in`, `a`, `o`, `to`, `an`, `die`, `on`) are left
 * out, because one of them in a sentence says nothing about which language
 * it is.
 */
const FUNCTION_WORDS: Record<AnswerLanguage, ReadonlySet<string>> = {
  de: words(
    "der das und ist mit von den dem des im ein eine einer eines nicht auf für " +
      "wurde wurden zu bei nach sich auch als wird sind oder durch beträgt betrug " +
      "laut gemäß unterzeichnet vom zur zum aus dass war haben hat"
  ),
  en: words(
    "the is was of and for with by at from that this during which were are has have " +
      "be it signed according its been not"
  ),
  pl: words(
    "w z się nie jest że jak od po przez dla był była było są oraz który która " +
      "które ten ta przy podczas według wynosi wynosiła wynosił został została " +
      "zostało zgodnie dokumentem przeprowadzono wykonano podpisał podpisała " +
      "podpisany podpisane ze na do pod nad jego jej tego tej"
  ),
  it: words(
    "il la le lo gli di del della dei delle che è sono nel nella dal dalla una uno " +
      "al alla stato stata durante secondo viene per con non dall dell firmato ed " +
      "anche questo questa"
  ),
};

const LANGUAGES = Object.keys(FUNCTION_WORDS) as AnswerLanguage[];

/** A Sources heading in any of the four languages, to the end of the answer. */
const SOURCES_HEADING = /^[\s*_#>-]*(sources|quellen|źródła|zrodla|fonti|fonte)\b[\s\S]*$/im;

function stripNonAnswerText(answer: string): string {
  return answer
    .replace(SOURCES_HEADING, "")
    .replace(/„[^“”"]*[“”"]/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/«[^»]*»/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, " ")
    .replace(/[*_#]/g, " ");
}

function classify(sentence: string): AnswerLanguage | null {
  const words = sentence.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  const hits = LANGUAGES.map((lang) => ({
    lang,
    n: words.filter((w) => FUNCTION_WORDS[lang].has(w)).length,
  })).sort((a, b) => b.n - a.n);
  const [first, second] = hits;
  if (!first || first.n < 2 || first.n === second?.n) return null;
  return first.lang;
}

/** The language of each classifiable sentence, in order, unclassified ones dropped. */
export function sentenceLanguages(answer: string): AnswerLanguage[] {
  return stripNonAnswerText(answer)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(classify)
    .filter((lang): lang is AnswerLanguage => lang !== null);
}

export interface AnswerLanguageVerdict {
  passed: boolean;
  /** The distinct languages found, in order of first appearance. */
  found: AnswerLanguage[];
}

/**
 * Passes when the answer is written in `expected` throughout: at least one
 * sentence reads as `expected`, and none reads as another language.
 */
export function gradeAnswerLanguage(
  answer: string,
  expected: AnswerLanguage
): AnswerLanguageVerdict {
  const found = [...new Set(sentenceLanguages(answer))];
  return {
    passed: found.length === 1 && found[0] === expected,
    found,
  };
}

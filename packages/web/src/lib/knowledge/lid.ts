/**
 * Dependency-free language identification (LID) for knowledge-base ingest.
 *
 * Scores tokenized, lowercased text against small per-language stopword
 * sets (function words: articles, pronouns, conjunctions, common
 * prepositions) plus a small bonus for language-distinctive characters
 * (e.g. German umlauts/ß, French/Italian/Spanish accents). The
 * highest-scoring language wins, provided it clears a minimum-evidence
 * threshold; otherwise the input is reported as undetermined ("und").
 *
 * This only needs to be roughly right — it tags `kb_documents.lang` /
 * `kb_chunks.lang` so a later normalization step can group same-language
 * content. It is not security-critical and intentionally skips a real
 * statistical/n-gram model (and its wasm/dependency footprint) in favor of
 * a tiny heuristic that nails the two languages that matter for the MVP
 * corpus (EN sources, DE queries) and cheaply covers a few neighbors.
 */

/** ISO 639-1 code, or "und" (undetermined) when confidence is too low. */
export type LangCode = "de" | "en" | "fr" | "es" | "it" | "und";

interface LanguageProfile {
  lang: Exclude<LangCode, "und">;
  stopwords: ReadonlySet<string>;
  /** Language-distinctive characters. Each occurrence in the raw text adds a small score bonus. */
  charBonus: RegExp | null;
}

const LANGUAGES: readonly LanguageProfile[] = [
  {
    lang: "de",
    stopwords: new Set([
      "der",
      "die",
      "das",
      "und",
      "ist",
      "nicht",
      "ein",
      "eine",
      "einer",
      "einem",
      "einen",
      "den",
      "dem",
      "des",
      "mit",
      "auf",
      "für",
      "von",
      "zu",
      "im",
      "in",
      "aber",
      "auch",
      "wir",
      "sie",
      "sich",
      "wie",
      "als",
      "aus",
      "dass",
      "können",
      "wenn",
      "über",
      "sind",
      "war",
      "werden",
      "diese",
      "dieser",
      "dies",
      "prüfen",
    ]),
    charBonus: /[äöüß]/g,
  },
  {
    lang: "en",
    stopwords: new Set([
      "the",
      "is",
      "and",
      "of",
      "to",
      "a",
      "an",
      "in",
      "that",
      "it",
      "for",
      "on",
      "with",
      "as",
      "this",
      "are",
      "was",
      "be",
      "by",
      "not",
      "we",
      "you",
      "but",
      "or",
      "at",
      "from",
      "have",
      "has",
      "our",
      "your",
    ]),
    charBonus: null,
  },
  {
    lang: "fr",
    stopwords: new Set([
      "le",
      "la",
      "les",
      "et",
      "est",
      "un",
      "une",
      "des",
      "de",
      "du",
      "en",
      "avec",
      "pour",
      "que",
      "qui",
      "dans",
      "sur",
      "ne",
      "pas",
      "ce",
      "cette",
      "au",
      "aux",
      "beaucoup",
      "comme",
    ]),
    charBonus: /[àâçéèêëîïôûùüÿœæ]/g,
  },
  {
    lang: "es",
    stopwords: new Set([
      "el",
      "la",
      "los",
      "las",
      "y",
      "es",
      "un",
      "una",
      "de",
      "del",
      "en",
      "con",
      "para",
      "que",
      "por",
      "no",
      "se",
      "su",
      "como",
      "muchas",
      "algunos",
      "esta",
    ]),
    charBonus: /[áéíóúñ¿¡]/g,
  },
  {
    lang: "it",
    stopwords: new Set([
      "il",
      "lo",
      "la",
      "gli",
      "le",
      "e",
      "è",
      "un",
      "una",
      "di",
      "del",
      "in",
      "con",
      "per",
      "che",
      "non",
      "si",
      "come",
      "questa",
      "molte",
      "alcuni",
      "più",
    ]),
    charBonus: /[àèéìòù]/g,
  },
];

/** Minimum score (in stopword hits, char bonuses counting as 0.5) to accept a language over "und". */
const MIN_SCORE = 1.5;
/** Minimum token count for a text to be eligible for detection at all. */
const MIN_TOKENS = 3;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}

export function detectLang(text: string): LangCode {
  const tokens = tokenize(text);
  if (tokens.length < MIN_TOKENS) return "und";

  let bestLang: LangCode = "und";
  let bestScore = 0;

  for (const { lang, stopwords, charBonus } of LANGUAGES) {
    let score = 0;
    for (const token of tokens) {
      if (stopwords.has(token)) score += 1;
    }

    if (charBonus) {
      const matches = text.match(charBonus);
      if (matches) score += matches.length * 0.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  return bestScore >= MIN_SCORE ? bestLang : "und";
}

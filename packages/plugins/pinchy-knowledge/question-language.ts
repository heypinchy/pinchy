/**
 * Which language a user's message is written in, named so the
 * knowledge_search result can tell the model (#1296).
 *
 * Saying which language matters more than asking for "the user's language".
 * The eval sweep measured both. With a German-named agent and German sources,
 * Claude Haiku 5.5 kept answering Polish questions in German when the tool
 * result asked for "the language of the user's question". Naming the language
 * in the same place moved it.
 *
 * Kept small on purpose: function words and letters only one of these
 * languages uses, for the languages Pinchy's deployments ask in. It names a
 * language only when one clearly leads, and returns null otherwise. A wrong
 * name is worse than none, because the caller states it as fact; with null
 * the caller falls back to the unnamed wording. A general-purpose detector was
 * tried and read "Kto podpisał protokół odbioru AP-2023-091?" as Czech.
 *
 * Words two of these languages share (`de`, `la`, `en`, `do`, `co`, `a`, `e`,
 * `o`) are left out, because one of them says nothing about which language a
 * sentence is in.
 */

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(" "));
}

interface LanguageSignal {
  name: string;
  words: ReadonlySet<string>;
  /**
   * Words a question or request opens with: question words and imperatives.
   * The opening word is the asker's own, while a German document title in an
   * English question brings German articles and prepositions with it, so a
   * match here adds 2.
   */
  openers: ReadonlySet<string>;
  /** Letters no other language in this list uses. Any of them adds 2, next to a word hit. */
  letters?: RegExp;
}

const LANGUAGES: readonly LanguageSignal[] = [
  {
    name: "German",
    openers: words(
      "was wie wer wann wo warum welche welcher welches gibt kannst bitte fasse erkläre erklär zeige zeig nenne beschreibe vergleiche finde"
    ),
    words: words(
      "der die das und ist wer wie wann wo warum welche welcher welches hat haben war " +
        "wurde wurden mit von den dem des im ein eine einer für auf nicht zu zur zum bei nach " +
        "steht gibt sind kann können bitte mir unser unsere dieser diese dieses über wird"
    ),
    letters: /[äß]/i,
  },
  {
    name: "English",
    openers: words(
      "what which who how when where why does can could please summarize summarise explain show list find give tell compare"
    ),
    words: words(
      "the is what which who how when where why of and for with by from that this " +
        "during are does did has have it signed"
    ),
  },
  {
    name: "French",
    openers: words(
      "qui quel quelle quels quelles comment où pourquoi combien résume résumez explique expliquez montre montrez décris"
    ),
    words: words(
      "le les du est qui quel quelle quels quelles pendant pour avec une un et dans sur où"
    ),
    letters: /[œ]/i,
  },
  {
    name: "Italian",
    openers: words(
      "chi quale quali quanto quante quanti come dove perché cosa ogni riassumi spiega mostra elenca trova descrivi"
    ),
    words: words(
      "il lo gli di del della dei delle che è chi ogni quante quanto quale quali sono " +
        "nel nella per non va ha"
    ),
  },
  {
    name: "Spanish",
    openers: words(
      "quién quiénes qué cuál cuáles cómo dónde cuándo cuánto cuántos explica muestra enumera"
    ),
    words: words("el los las quién qué cuál cuándo cómo es son por para una y se firmó"),
    letters: /[¿¡ñ]/i,
  },
  {
    name: "Polish",
    openers: words(
      "kto jaka jaki jakie jakiego jakiej czy ile gdzie kiedy dlaczego opisz podaj wymień proszę pokaż streść wyjaśnij porównaj znajdź"
    ),
    words: words(
      "kto jaka jaki jakie jakiego jakiej czy ile gdzie kiedy jest są się nie w dla " +
        "podczas przez który która które oraz należy trzeba tym"
    ),
    letters: /[ąćęłńśźż]/i,
  },
  {
    name: "Dutch",
    openers: words("wat welke wanneer waar hoe waarom vat toon geef beschrijf"),
    words: words("het een wie wat welke wanneer waar hoe van voor met op heeft hebben was"),
  },
  {
    name: "Czech",
    openers: words("kdo kde kdy proč kolik shrň vysvětli ukaž popiš"),
    words: words("kdo kde kdy je jsou pro který která které podepsal v"),
    letters: /[ěřůťď]/i,
  },
  {
    name: "Portuguese",
    openers: words("quem qual onde porque resuma explique mostre descreva"),
    words: words("quem qual quando foi são com uma não da dos das"),
    letters: /[ãõ]/i,
  },
];

/**
 * The words the user typed. Pinchy appends a `<pinchy:attachments>` block of
 * English markup and workspace paths to a message that carries files; left in,
 * it reads as English and outvotes a short question in any other language.
 */
export function questionText(prompt: string): string {
  return prompt.replace(/<pinchy:attachments>[\s\S]*?<\/pinchy:attachments>/g, " ").trim();
}

/** Quoted wording is the documents' language, not the asker's. */
function stripQuoted(text: string): string {
  return text
    .replace(/„[^“”"]*[“”"]/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/«[^»]*»/g, " ");
}

export function detectQuestionLanguage(text: string): string | null {
  const stripped = stripQuoted(questionText(text));
  const tokens = stripped.toLowerCase().match(/\p{L}+/gu) ?? [];
  const opener = tokens[0];
  // Capitalised words are blanked before the letter check: in a question about
  // German documents the ä and ß sit in nouns, titles and names
  // ("Qualitätshandbuch", "Łukasz"), not in the asker's own words.
  const lowercaseOnly = stripped.replace(/(?<!\p{L})\p{Lu}\p{L}*/gu, " ");
  const scores = LANGUAGES.map((lang) => {
    const wordHits =
      tokens.filter((t) => lang.words.has(t)).length +
      (opener !== undefined && lang.openers.has(opener) ? 2 : 0);
    const letterBonus = wordHits > 0 && lang.letters?.test(lowercaseOnly) ? 2 : 0;
    return { name: lang.name, score: wordHits + letterBonus };
  }).sort((a, b) => b.score - a.score);
  const [first, second] = scores;
  if (!first || first.score < 2 || first.score === second?.score) return null;
  return first.name;
}

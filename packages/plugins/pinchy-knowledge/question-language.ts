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
  /** Letters no other language in this list uses. Any of them adds 2. */
  letters?: RegExp;
}

const LANGUAGES: readonly LanguageSignal[] = [
  {
    name: "German",
    words: words(
      "der die das und ist wer wie wann wo warum welche welcher welches hat haben war " +
        "wurde wurden mit von den dem des im ein eine einer für auf nicht zu bei nach"
    ),
    letters: /[äß]/i,
  },
  {
    name: "English",
    words: words(
      "the is what which who how when where why of and for with by from that this " +
        "during are does did has have it signed"
    ),
  },
  {
    name: "French",
    words: words(
      "le les du est qui quel quelle quels quelles pendant pour avec une un et dans sur où"
    ),
    letters: /[œ]/i,
  },
  {
    name: "Italian",
    words: words(
      "il lo gli di del della dei delle che è chi ogni quante quanto quale quali sono " +
        "nel nella per non va ha"
    ),
  },
  {
    name: "Spanish",
    words: words("el los las quién qué cuál cuándo cómo es son por para una y se firmó"),
    letters: /[¿¡ñ]/i,
  },
  {
    name: "Polish",
    words: words(
      "kto jaka jaki jakie jakiego jakiej czy ile gdzie kiedy jest są się nie w dla " +
        "podczas przez który która które oraz należy trzeba tym"
    ),
    letters: /[ąćęłńśźż]/i,
  },
  {
    name: "Dutch",
    words: words("het een wie wat welke wanneer waar hoe van voor met op heeft hebben was"),
  },
  {
    name: "Czech",
    words: words("kdo kde kdy je jsou pro který která které podepsal v"),
    letters: /[ěřůťď]/i,
  },
  {
    name: "Portuguese",
    words: words("quem qual quando foi são com uma não da dos das"),
    letters: /[ãõ]/i,
  },
];

/** Quoted wording is the documents' language, not the asker's. */
function stripQuoted(text: string): string {
  return text
    .replace(/„[^“”"]*[“”"]/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/«[^»]*»/g, " ");
}

export function detectQuestionLanguage(text: string): string | null {
  const stripped = stripQuoted(text);
  const tokens = stripped.toLowerCase().match(/\p{L}+/gu) ?? [];
  const scores = LANGUAGES.map((lang) => ({
    name: lang.name,
    score:
      tokens.filter((t) => lang.words.has(t)).length +
      (lang.letters && lang.letters.test(stripped) ? 2 : 0),
  })).sort((a, b) => b.score - a.score);
  const [first, second] = scores;
  if (!first || first.score < 2 || first.score === second?.score) return null;
  return first.name;
}

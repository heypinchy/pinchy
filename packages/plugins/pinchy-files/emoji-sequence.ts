/**
 * Where the zero-width format characters — U+200C (zero-width non-joiner),
 * U+200D (zero-width joiner), U+FE0E / U+FE0F (text / emoji presentation) —
 * are part of what a person sees.
 *
 * Inside an emoji the joiner and the selectors are part of a visible glyph:
 * ⚠️, 👨‍👩‍👧, 🏳️‍🌈, 1️⃣. In Arabic-script and Indic text the two joiners shape
 * the letters around them (seventh review of #1242): the Persian plural
 * گزارش‌ها keeps its ش unjoined, Sinhala ශ්‍රී is drawn with a rakaaraansaya,
 * Malayalam അവന്‍ ends in a chillu. Anywhere else they render as nothing, so
 * `a\u200Db.md` reads exactly like `ab.md`, and `RE-1001\uFE0F` like
 * `RE-1001`.
 *
 * Three places have to agree on which is which (sixth and seventh review of
 * #1242): pinchy-files `plain-path.ts` refuses a path that carries one where
 * it renders as nothing, pinchy-email `recipient.ts` refuses such a U+200C in
 * a display name, and the approval card
 * (`packages/web/src/lib/approvals/summary.ts`) marks such a one as
 * `⟨U+XXXX⟩`. They all read this module, so they cannot drift. It is
 * duplicated byte-identically in pinchy-email and pinchy-files, because a
 * plugin can import nothing outside its own directory; the web package reaches
 * the pinchy-files copy with a relative import, which is why it must stay
 * import-free (anything it imported would become a web build dependency).
 * `hidden-chars-drift.test.ts` pins the copies together and the card's marking
 * to both tools.
 */

/**
 * One emoji: a pictograph (or a keycap digit) with an optional presentation
 * selector and skin tone, and any further pictographs joined to it by U+200D
 * — ⚠️, ❤️, 👨‍👩‍👧, 👩🏽‍💻, 🏳️‍🌈, 1️⃣.
 */
const EMOJI_SEQUENCE =
  /(?:\p{Extended_Pictographic}|[0-9#*](?=\uFE0F\u20E3))[\uFE0E\uFE0F]?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*/gu;

const EMOJI_FORMAT = /[\u200D\uFE0E\uFE0F]/g;
/** Every format character this module decides about. */
const FORMAT = /[\u200C\u200D\uFE0E\uFE0F]/g;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;

/**
 * The UTF-16 offsets of the emoji format characters in `text` that are part
 * of an emoji. Every other one renders as nothing.
 */
export function emojiFormatOffsets(text: string): Set<number> {
  const offsets = new Set<number>();
  for (const match of text.matchAll(EMOJI_SEQUENCE)) {
    for (const format of match[0].matchAll(EMOJI_FORMAT)) {
      offsets.add(match.index + format.index);
    }
  }
  return offsets;
}

/**
 * The UTF-16 offsets of every U+FE0F that asks for emoji presentation from a
 * character that is shown as an emoji by default (`\p{Emoji_Presentation}`:
 * ✅, 📄, a skin tone). It changes nothing on screen, so `✅\uFE0F.pdf` reads
 * exactly like `✅.pdf` — and is a different file.
 *
 * Only this direction is certain. A U+FE0E after an emoji-by-default
 * character does change it (✅\uFE0E is drawn as text), and whether a character
 * that is text by default is drawn as text depends on the platform's fonts, so
 * neither of those is called redundant.
 */
export function redundantSelectorOffsets(text: string): Set<number> {
  const offsets = new Set<number>();
  let previous = "";
  let offset = 0;
  for (const char of text) {
    if (char === "\uFE0F" && EMOJI_PRESENTATION.test(previous)) offsets.add(offset);
    previous = char;
    offset += char.length;
  }
  return offsets;
}

/**
 * Canonical_Combining_Class 9 (Virama), derived from canonical ordering.
 *
 * JavaScript cannot ask for a combining class (`\p{Canonical_Combining_Class=Virama}`
 * is not a property a RegExp accepts), but `normalize("NFD")` sorts adjacent
 * combining marks by it: two marks swap when the first has the higher class.
 * So a mark M has class 9 exactly when it sorts after U+3099 (class 8) and
 * before U+05B0 (class 10). Both reference classes are fixed by Unicode's
 * stability policy, and the set follows whatever Unicode version the runtime
 * ships — no table to keep current. Computed once, on first use, over the
 * planes that hold combining marks with a class other than 0 (0 and 1).
 */
let viramas: Set<number> | undefined;

const MARK = /^\p{M}$/u;
const CLASS_8 = "゙";
const CLASS_10 = "ְ";

function viramaSet(): Set<number> {
  if (viramas) return viramas;
  viramas = new Set<number>();
  for (let cp = 0; cp <= 0x1ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const mark = String.fromCodePoint(cp);
    if (mark === CLASS_8 || mark === CLASS_10 || !MARK.test(mark)) continue;
    if (mark.normalize("NFD") !== mark) continue;
    const afterClass8 = `a${mark}${CLASS_8}`.normalize("NFD") === `a${CLASS_8}${mark}`;
    const beforeClass10 = `a${CLASS_10}${mark}`.normalize("NFD") === `a${mark}${CLASS_10}`;
    if (afterClass8 && beforeClass10) viramas.add(cp);
  }
  return viramas;
}

/** Is `char` a virama (Canonical_Combining_Class 9)? */
export function isVirama(char: string): boolean {
  const cp = char.codePointAt(0);
  return cp !== undefined && char.length === String.fromCodePoint(cp).length && viramaSet().has(cp);
}

/**
 * The scripts that have a virama (Canonical_Combining_Class 9), by their
 * Unicode property value names. A joiner after a virama shapes text only
 * between letters of the virama's own script, and JavaScript cannot ask a
 * character for its script — it can only test it against a named one
 * (`\p{Script_Extensions=…}`). So the names are listed, and the test file pins
 * the list to every virama of Unicode 16.0: a virama whose script is missing
 * here would have every joiner after it refused, never accepted.
 */
const VIRAMA_SCRIPT_NAMES = [
  "Devanagari",
  "Bengali",
  "Gurmukhi",
  "Gujarati",
  "Oriya",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Sinhala",
  "Thai",
  "Lao",
  "Tibetan",
  "Myanmar",
  "Tagalog",
  "Hanunoo",
  "Khmer",
  "Tai_Tham",
  "Balinese",
  "Sundanese",
  "Batak",
  "Tifinagh",
  "Syloti_Nagri",
  "Saurashtra",
  "Rejang",
  "Javanese",
  "Meetei_Mayek",
  "Kharoshthi",
  "Brahmi",
  "Kaithi",
  "Chakma",
  "Sharada",
  "Khojki",
  "Khudawadi",
  "Grantha",
  "Tulu_Tigalari",
  "Newa",
  "Tirhuta",
  "Siddham",
  "Modi",
  "Takri",
  "Ahom",
  "Dogra",
  "Dives_Akuru",
  "Nandinagari",
  "Zanabazar_Square",
  "Soyombo",
  "Bhaiksuki",
  "Masaram_Gondi",
  "Gunjala_Gondi",
  "Kawi",
  "Gurung_Khema",
];

let viramaScripts: Array<{ name: string; test: RegExp }> | undefined;

function viramaScriptPatterns(): Array<{ name: string; test: RegExp }> {
  if (viramaScripts) return viramaScripts;
  viramaScripts = [];
  for (const name of VIRAMA_SCRIPT_NAMES) {
    try {
      viramaScripts.push({ name, test: new RegExp(`^\\p{Script_Extensions=${name}}$`, "u") });
    } catch {
      // A runtime on an older Unicode does not know the newest scripts. It
      // knows none of their letters or viramas either, so nothing is lost.
    }
  }
  return viramaScripts;
}

/** The script of a virama, by its Unicode name, or `undefined` for anything else. */
export function viramaScript(char: string): string | undefined {
  if (!isVirama(char)) return undefined;
  return viramaScriptPatterns().find(({ test }) => test.test(char))?.name;
}

/**
 * The letters on which a U+200D after a virama is visible at the end of a
 * word (ninth review of #1242), by the virama's script. With no letter after
 * it there is no conjunct to shape, so the joiner draws something only where
 * the Unicode core spec (chapter 12) gives the dead consonant a form of its
 * own — and only on the letters that have one:
 *
 * - Devanagari: the independent half form (§12.1, Figure 12-6), for the
 *   consonants Table 12-4 gives a half form — क ख ग घ च ज झ ञ ण त थ ध न ऩ प
 *   फ ब भ म य ल व श ष स, and the nukta forms of those — and RA, drawn as the
 *   eyelash (rule R5a). A consonant without a half form falls back to the
 *   visible virama (§12.1), which is what it shows without the joiner; so
 *   does RRA, which is the eyelash already (rule R5).
 * - Bengali: ta, the legacy encoding of khanda ta (§12.2, "Khanda Ta").
 * - Malayalam: the five chillus that had a legacy <virama, ZWJ> encoding —
 *   ണ ന ര ല ള (§12.9, Table 12-40).
 *
 * Every other script — Tamil, Thai, Myanmar, Telugu, Gujarati, … — is
 * absent on purpose: the spec documents no form there, so the joiner is
 * taken to render as nothing and the card marks it. `தமிழ்‍.md` read exactly
 * like `தமிழ்.md`.
 */
const WORD_FINAL_JOINER_LETTERS: Record<string, RegExp> = {
  Devanagari:
    /^[\u0915-\u0918\u091A\u091C-\u091E\u0923-\u0925\u0927-\u0930\u0932\u0935-\u0938\u0958-\u095B\u095E\u095F]$/u,
  Bengali: /^\u09A4$/u,
  Malayalam: /^[\u0D23\u0D28\u0D30\u0D32\u0D33]$/u,
};

/**
 * The letters after which a U+200D BEFORE a virama shapes the cluster, by the
 * virama's script (ninth review of #1242) — each a form the Unicode core spec
 * (chapter 12) documents:
 *
 * - Devanagari RA keeps its full form instead of a repha, and the following
 *   consonant takes a reduced form (§12.1, "Alternative Forms of
 *   Cluster-Initial RA");
 * - Bengali ra, and the Assamese ra ৰ (§12.2, "Characters for Assamese"),
 *   take the ya-phalaa instead of a repha: র‍্য as in র‍্যাংকিং (§12.2,
 *   "Interaction of Repha and Ya-phalaa"). After any other letter the
 *   ya-phalaa is the default, and the spec says "a ZWJ is not necessary";
 * - Telugu ra (§12.7, "Reph") and Kannada ra (§12.8, "Consonant Clusters
 *   Involving RA") switch between the reph and the full form;
 * - Oriya consonants take a half form as the final consonant (§12.1, Figure
 *   12-7), and Malayalam consonants a traditional ligature (§12.9,
 *   "Requesting Traditional Ligatures").
 */
const JOINER_BEFORE_VIRAMA_LETTERS: Record<string, RegExp> = {
  Devanagari: /^\u0930$/u,
  Bengali: /^[\u09B0\u09F0]$/u,
  Telugu: /^\u0C30$/u,
  Kannada: /^\u0CB0$/u,
  Oriya: /^[\u0B15-\u0B39\u0B5C\u0B5D\u0B5F\u0B71]$/u,
  Malayalam: /^[\u0D15-\u0D3A]$/u,
};

/**
 * Does the joiner at `chars[index]`, right after a virama, shape the text?
 * RFC 5892's CONTEXTJ asks only for the virama; this asks what the joiner
 * acts on as well (eighth review of #1242), because a joiner that acts on
 * nothing renders as nothing — `जगत्‌.md` reads exactly like `जगत्.md`:
 *
 * - the virama sits on a letter of its own script (marks such as a nukta
 *   between them are skipped), so `a्‌b` shapes nothing;
 * - a U+200C keeps the virama from forming a conjunct with the letter after
 *   it, and a U+200D asks for the half form of the consonant before it, so
 *   either needs a letter of the same script after it;
 * - with none, a U+200D is visible only on the letters
 *   `WORD_FINAL_JOINER_LETTERS` lists: a half form, a khanda ta, a chillu
 *   (അവന്‍).
 */
function joinerShapesVirama(chars: string[], index: number): boolean {
  const script = viramaScriptPatterns().find(({ test }) => test.test(chars[index - 1]));
  if (!script) return false;
  let base = index - 2;
  while (base >= 0 && MARK.test(chars[base])) base--;
  if (base < 0 || !LETTER.test(chars[base]) || !script.test.test(chars[base])) return false;
  const next = chars[index + 1];
  if (next !== undefined && LETTER.test(next)) return script.test.test(next);
  if (chars[index] !== "\u200D") return false;
  return WORD_FINAL_JOINER_LETTERS[script.name]?.test(chars[base]) ?? false;
}

/**
 * Does the U+200D at `chars[index]`, right before a virama, shape the text?
 * Only after a letter `JOINER_BEFORE_VIRAMA_LETTERS` lists for the virama's
 * script, and only with a letter of that script after the virama — the
 * consonant whose form the joiner changes.
 */
function joinerShapesBeforeVirama(chars: string[], index: number): boolean {
  if (chars[index] !== "\u200D" || index === 0) return false;
  const virama = chars[index + 1];
  if (virama === undefined || !isVirama(virama)) return false;
  const script = viramaScriptPatterns().find(({ test }) => test.test(virama));
  const letters = script && JOINER_BEFORE_VIRAMA_LETTERS[script.name];
  if (!script || !letters || !letters.test(chars[index - 1])) return false;
  const next = chars[index + 2];
  return next !== undefined && LETTER.test(next) && script.test.test(next);
}

/**
 * The letters of the scripts whose letters join — the ones Unicode's
 * ArabicShaping.txt gives a Joining_Type other than U (non-joining).
 *
 * JavaScript has no `\p{Joining_Type}`, so this approximates it: a letter of
 * one of these scripts is taken as dual-joining (D), except in the main Arabic
 * block (U+0620–U+06FF) — the one Persian, Urdu and Arabic text is written in
 * — where the letters that join only to the right (R: ا د ذ ر ز ژ و ة …) and
 * the ones that do not join at all (U: ء, the high hamza, the small waw and
 * yeh) are listed below exactly. Elsewhere (Syriac, N'Ko, Mongolian, the
 * Arabic supplements, …) the approximation is generous: a ZWNJ after a
 * right-joining letter there is accepted although it changes nothing on
 * screen. The card and the tools read the same rule, so they still agree on
 * every such character; they only show it rather than mark it.
 */
const JOINING_SCRIPT =
  /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Mandaic}\p{Script=Manichaean}\p{Script=Psalter_Pahlavi}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Sogdian}\p{Script=Old_Uyghur}\p{Script=Chorasmian}\p{Script=Phags_Pa}]$/u;
const LETTER = /^\p{L}$/u;
/** Arabic letters that join only to the right (Joining_Type R). */
const RIGHT_JOINING = /^[آ-إاةد-زوٱ-ٳٵ-ٷڈ-ڙۀۃ-ۋۍۏےۓەۮۯ]$/u;
/** Arabic letters that do not join (Joining_Type U), and the join-causing tatweel. */
const NON_JOINING = /^[ءـٴۥۦ]$/u;
/** Joining_Type T: marks that sit on a letter without breaking its joining. */
const TRANSPARENT = /^[\p{Mn}\p{Me}]$/u;

function isJoiningLetter(char: string | undefined): boolean {
  return (
    char !== undefined && LETTER.test(char) && JOINING_SCRIPT.test(char) && !NON_JOINING.test(char)
  );
}

/** Joining_Type L or D: the letter joins to the one after it. */
function joinsForward(char: string | undefined): boolean {
  return isJoiningLetter(char) && !RIGHT_JOINING.test(char!);
}

/** Joining_Type R or D: the letter joins to the one before it. */
function joinsBackward(char: string | undefined): boolean {
  return isJoiningLetter(char);
}

/**
 * The UTF-16 offsets of every U+200C / U+200D in `text` that changes how the
 * text is drawn — an approximation of IDNA's CONTEXTJ rule (RFC 5892,
 * Appendix A.1 and A.2), stricter after a virama and, outside the main Arabic
 * block, more permissive between joining letters:
 *
 * - right after a virama, where it acts on letters of the virama's script
 *   (`joinerShapesVirama`): क्‌ष (an explicit half form), ශ්‍රී, അവന്‍ (a chillu);
 * - a U+200D right before a virama, where the spec gives it a form
 *   (`joinerShapesBeforeVirama`): the Bengali ya-phalaa র‍্য;
 * - a U+200C between a letter that joins forward and one that joins backward,
 *   with only marks between them: گزارش‌ها.
 *
 * Joining types are approximated as described at `JOINING_SCRIPT`.
 */
export function contextualJoinerOffsets(text: string): Set<number> {
  const chars = [...text];
  const offsets = new Set<number>();
  let offset = 0;
  for (let i = 0; i < chars.length; offset += chars[i].length, i++) {
    const char = chars[i];
    if (char !== "\u200C" && char !== "\u200D") continue;
    if (i > 0 && isVirama(chars[i - 1])) {
      if (joinerShapesVirama(chars, i)) offsets.add(offset);
      continue;
    }
    if (joinerShapesBeforeVirama(chars, i)) {
      offsets.add(offset);
      continue;
    }
    if (char !== "\u200C") continue;
    let before = i - 1;
    while (before >= 0 && TRANSPARENT.test(chars[before])) before--;
    let after = i + 1;
    while (after < chars.length && TRANSPARENT.test(chars[after])) after++;
    if (joinsForward(chars[before]) && joinsBackward(chars[after])) offsets.add(offset);
  }
  return offsets;
}

/**
 * The format characters in `text` that render as nothing, as UTF-16 offsets:
 * a U+200D, U+FE0E or U+FE0F outside an emoji, a U+200C or U+200D where it
 * shapes no Arabic-script or Indic text (`contextualJoinerOffsets`), and —
 * with `redundant` — a U+FE0F that changes nothing (see
 * `redundantSelectorOffsets`).
 */
export function invisibleFormatOffsets(
  text: string,
  { redundant }: { redundant: boolean }
): Set<number> {
  const inEmoji = emojiFormatOffsets(text);
  const shapesText = contextualJoinerOffsets(text);
  const changesNothing = redundant ? redundantSelectorOffsets(text) : new Set<number>();
  const offsets = new Set<number>();
  for (const format of text.matchAll(FORMAT)) {
    if (shapesText.has(format.index)) continue;
    if (!inEmoji.has(format.index) || changesNothing.has(format.index)) offsets.add(format.index);
  }
  return offsets;
}

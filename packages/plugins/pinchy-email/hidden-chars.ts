/**
 * Characters that render as nothing, or as blank space, without being a plain
 * space (U+0020): controls, format characters (zero-width, bidi overrides,
 * Unicode tags), every other space separator (no-break, ideographic, …), line
 * and paragraph separators, every default-ignorable code point (variation
 * selectors, the Hangul fillers U+115F / U+1160 / U+3164 / U+FFA0, …), the
 * braille pattern blank U+2800, which is none of those and still prints as an
 * empty cell — and a lone UTF-16 surrogate, which is not a character at all.
 *
 * A tool that a person approves on a confirmation card refuses them in the
 * values that decide where the action lands — a recipient, a path — because a
 * run of them looks like empty space and pushes what follows out of view.
 *
 * Three groups are refused by default but may be allowed by a caller, each
 * for a reason that holds only where that caller uses it:
 *
 * - `isEmojiFormatChar` — U+200D, U+FE0E, U+FE0F. They take no space and sit
 *   inside ordinary emoji (👨‍👩‍👧, ❤️). The card marks every one, inside an
 *   emoji too — whether a sequence is drawn as one glyph is the approver's
 *   font. A display name and a path may carry them; an
 *   address may not.
 * - `isJoiner` — U+200C, U+200D. Arabic-script and Indic names carry them
 *   (گزارش‌ها, ශ්‍රී), and the card marks every one, so a path and a display
 *   name may carry them anywhere: `a⟨U+200D⟩b.md` never reads as `ab.md`.
 * - `isSpaceSeparator` — every space separator other than U+0020 (`\p{Zs}`:
 *   no-break, narrow no-break, ideographic, …). They take visible width, and
 *   the card prints each one as `⟨U+XXXX⟩`. Real file names carry them —
 *   macOS names a screenshot "… at 10.00.00 AM.png" — so a path may.
 *   So may a display name, one at a time: Japanese
 *   writes a name with an ideographic space, and a run of them is blank
 *   space again (pinchy-email `recipient.ts`).
 *
 * Duplicated byte-identically in pinchy-email and pinchy-files (plugins cannot
 * import each other); `packages/web/src/__tests__/lib/hidden-chars-drift.test.ts`
 * pins the copies together, pins the approval summary's escaping to them, and
 * pins each allowance to what the card does with it.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Z}\p{Default_Ignorable_Code_Point}⠀ᅟᅠㅤﾠ]/u;

const EMOJI_FORMAT = new Set(["‍", "︎", "️"]);
const SPACE_SEPARATOR = /^\p{Zs}$/u;

/** U+200D (zero-width joiner), U+FE0E / U+FE0F (text / emoji presentation). */
export function isEmojiFormatChar(char: string): boolean {
  return EMOJI_FORMAT.has(char);
}

/** U+200C (zero-width non-joiner), U+200D (zero-width joiner). */
export function isJoiner(char: string): boolean {
  return char === "\u200C" || char === "\u200D";
}

/** A space separator (`\p{Zs}`) other than the plain space U+0020. */
export function isSpaceSeparator(char: string): boolean {
  return char !== " " && SPACE_SEPARATOR.test(char);
}

/**
 * The first hidden character in `text` as `U+XXXX`, or `null` if there is
 * none. A plain space is not hidden; a character `allow` accepts is skipped.
 */
export function hiddenCharIn(
  text: string,
  allow: (char: string) => boolean = () => false
): string | null {
  for (const char of text) {
    if (char !== " " && HIDDEN.test(char) && !allow(char)) {
      return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return null;
}

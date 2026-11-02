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
 * run of them looks like empty space and pushes what follows out of view
 * (second review of #1242).
 *
 * Two groups are refused by default but may be allowed by a caller, each for a
 * reason that holds only where that caller uses it (third review of #1242):
 *
 * - `isEmojiFormatChar` — U+200D, U+FE0E, U+FE0F. They take no space, sit
 *   inside ordinary emoji (👨‍👩‍👧, ❤️), and the card shows them as they are
 *   there — and marks one anywhere else, where it renders as nothing
 *   (pinchy-files `emoji-sequence.ts`). A display name may carry them; an
 *   address may not; a path may only inside an emoji (pinchy-files
 *   `plain-path.ts`), or `a⟨U+200D⟩b.md` would pass for `ab.md`.
 * - `isSpaceSeparator` — every space separator other than U+0020 (`\p{Zs}`:
 *   no-break, narrow no-break, ideographic, …). They take visible width, and
 *   the card prints each one as `⟨U+XXXX⟩`. Real file names carry them —
 *   macOS names a screenshot "… at 10.00.00 AM.png" — so a path may.
 *   So may a display name, one at a time (ninth review of #1242): Japanese
 *   writes a name with an ideographic space, and a run of them is blank
 *   space again (pinchy-email `recipient.ts`).
 *
 * A third allowance depends on position rather than on the character: U+200C
 * and U+200D where they shape Arabic-script or Indic text (after a virama, or
 * a U+200C between letters that would otherwise join — RFC 5892 CONTEXTJ,
 * seventh review of #1242). `emoji-sequence.ts` decides that, and the callers
 * take those out before asking `hiddenCharIn`.
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

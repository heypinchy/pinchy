/**
 * Characters that render as nothing, or as blank space, without being a plain
 * space (U+0020): controls, format characters (zero-width, bidi overrides,
 * Unicode tags), every other space separator (no-break, ideographic, …), line
 * and paragraph separators, every default-ignorable code point (variation
 * selectors, the Hangul fillers U+115F / U+1160 / U+3164 / U+FFA0, …) and the
 * braille pattern blank U+2800, which is none of those and still prints as an
 * empty cell.
 *
 * A tool that a person approves on a confirmation card refuses them in the
 * values that decide where the action lands — a recipient, a path — because a
 * run of them looks like empty space and pushes what follows out of view
 * (second review of #1242).
 *
 * Duplicated byte-identically in pinchy-email and pinchy-files (plugins cannot
 * import each other); `packages/web/src/__tests__/lib/hidden-chars-drift.test.ts`
 * pins the copies together and pins the approval summary's escaping to them.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}⠀ᅟᅠㅤﾠ]/u;

/**
 * The first hidden character in `text` as `U+XXXX`, or `null` if there is
 * none. A plain space is not hidden.
 */
export function hiddenCharIn(text: string): string | null {
  for (const char of text) {
    if (char !== " " && HIDDEN.test(char)) {
      return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return null;
}

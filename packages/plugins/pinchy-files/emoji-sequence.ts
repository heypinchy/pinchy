/**
 * Where the zero-width format characters — U+200C (zero-width non-joiner),
 * U+200D (zero-width joiner), U+FE0E / U+FE0F (text / emoji presentation) —
 * are shown as they are on the approval card, and where they are marked as
 * `⟨U+XXXX⟩`.
 *
 * One rule (tenth review of #1242): they are shown as they are only inside a
 * full RGI emoji — `\p{RGI_Emoji}`, Unicode's list of the emoji every vendor
 * draws: ⚠️, 👨‍👩‍👧, 🏳️‍🌈, 👩🏽‍💻, 1️⃣. There they are part of one glyph.
 * Everywhere else they are marked, so two names that differ only by one of
 * them never look the same.
 *
 * The seventh to ninth reviews tried to decide, script by script, where a
 * joiner shapes Arabic-script or Indic text and showed it raw there. Each
 * review found more places where it draws nothing — Tamil க்‌ம, Thai กฺ‍ม,
 * Myanmar က်‍မ, Sinhala ක්‍ම, Devanagari क्‍म in Devanagari MT, each
 * pixel-identical to the name without it — and so did "any two pictographs
 * joined by a ZWJ": 📄‍📄 is drawn like 📄📄. Whether a joiner draws something
 * depends on the font, which the card cannot know. A marker costs the person
 * approving a glance; a joiner shown raw where it draws nothing costs them the
 * difference between two files.
 *
 * An emoji newer than the runtime's Unicode data is not in its `RGI_Emoji`, so
 * its format characters are marked — the safe side. So is everything, on a
 * runtime without the RegExp `v` flag that `\p{RGI_Emoji}` needs.
 *
 * Three places read this rule: the approval card
 * (`packages/web/src/lib/approvals/summary.ts`) marks these offsets, in paths
 * and recipients alike; pinchy-files `plain-path.ts` refuses a presentation
 * selector at one of them (no file name needs one outside an emoji) and
 * accepts a joiner there, which Indic and Persian names need and the card
 * marks. pinchy-email accepts all four in a display name, where the card marks
 * them the same way. The web package reaches this file with a relative
 * import, which is why it must stay import-free (anything it imported would
 * become a web build dependency). `hidden-chars-drift.test.ts` pins the card's
 * marking to both tools.
 */

const FORMAT = /[\u200C\u200D\uFE0E\uFE0F]/g;

let rgiEmoji: RegExp | null | undefined;

/** `\p{RGI_Emoji}`, or `null` on a runtime that cannot express it. */
function rgiEmojiPattern(): RegExp | null {
  if (rgiEmoji === undefined) {
    try {
      // Built from a string: the `v` flag postdates the TypeScript target.
      rgiEmoji = new RegExp("\\p{RGI_Emoji}", "gv");
    } catch {
      rgiEmoji = null;
    }
  }
  return rgiEmoji;
}

/**
 * The UTF-16 offsets of the format characters in `text` that the card marks:
 * every U+200C, U+200D, U+FE0E and U+FE0F that is not part of a full RGI
 * emoji.
 */
export function markedFormatOffsets(text: string): Set<number> {
  const inEmoji = new Set<number>();
  const emoji = rgiEmojiPattern();
  if (emoji) {
    for (const match of text.matchAll(emoji)) {
      for (const format of match[0].matchAll(FORMAT)) inEmoji.add(match.index + format.index);
    }
  }
  const marked = new Set<number>();
  for (const format of text.matchAll(FORMAT)) {
    if (!inEmoji.has(format.index)) marked.add(format.index);
  }
  return marked;
}

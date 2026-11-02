/**
 * Where the emoji format characters — U+200D (zero-width joiner), U+FE0E /
 * U+FE0F (text / emoji presentation) — are part of what a person sees.
 *
 * Inside an emoji they are part of a visible glyph: ⚠️, 👨‍👩‍👧, 🏳️‍🌈, 1️⃣.
 * Anywhere else they render as nothing, so `a\u200Db.md` reads exactly like
 * `ab.md`, and `RE-1001\uFE0F` like `RE-1001`. Two places have to agree on
 * which is which (sixth review of #1242): pinchy-files `plain-path.ts` refuses
 * a path that carries one outside an emoji, and the approval card
 * (`packages/web/src/lib/approvals/summary.ts`) marks such a one as
 * `⟨U+XXXX⟩`. Both import this module, so they cannot drift; the web package
 * reaches it with a relative import, which is why it must stay import-free
 * (a plugin can import nothing outside its own directory, and anything this
 * file imported would become a web build dependency).
 * `hidden-chars-drift.test.ts` pins the card's marking to the path rule.
 */

/**
 * One emoji: a pictograph (or a keycap digit) with an optional presentation
 * selector and skin tone, and any further pictographs joined to it by U+200D
 * — ⚠️, ❤️, 👨‍👩‍👧, 👩🏽‍💻, 🏳️‍🌈, 1️⃣.
 */
const EMOJI_SEQUENCE =
  /(?:\p{Extended_Pictographic}|[0-9#*](?=\uFE0F\u20E3))[\uFE0E\uFE0F]?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*/gu;

const EMOJI_FORMAT = /[\u200D\uFE0E\uFE0F]/g;
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
 * The emoji format characters in `text` that render as nothing: those outside
 * an emoji, and — with `redundant` — a U+FE0F that changes nothing (see
 * `redundantSelectorOffsets`). As UTF-16 offsets.
 */
export function invisibleEmojiFormatOffsets(
  text: string,
  { redundant }: { redundant: boolean }
): Set<number> {
  const inEmoji = emojiFormatOffsets(text);
  const changesNothing = redundant ? redundantSelectorOffsets(text) : new Set<number>();
  const offsets = new Set<number>();
  for (const format of text.matchAll(EMOJI_FORMAT)) {
    if (!inEmoji.has(format.index) || changesNothing.has(format.index)) offsets.add(format.index);
  }
  return offsets;
}

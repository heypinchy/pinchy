/**
 * Display rules shared by the three renderings of a pending confirmation: the
 * stored summary (`summary.ts`), the in-app card (`approval-card.tsx`) and the
 * chat-channel prompt (`prompt.ts`).
 *
 * Import-free on purpose: the card is a Client Component, and `summary.ts`
 * pulls in `node:url`, which must not reach the client bundle.
 */

/**
 * Keys that name who a message reaches. Exact spellings, so the set stays
 * small: a case-insensitive match would let 1,024 spellings of "recipients"
 * crowd out the real `to`.
 */
export const RECIPIENT_KEYS: ReadonlySet<string> = new Set([
  "to",
  "cc",
  "bcc",
  "from",
  "sender",
  "reply_to",
  "replyTo",
  "recipient",
  "recipients",
]);

/**
 * Keys that name WHERE an action lands: the file it writes or deletes, the
 * record it acts on, the URL it calls. Taken from the write tools' own schemas
 * (pinchy-files `path` / `filename`, pinchy-odoo `model` / `ids` / `target` /
 * `targets` / `targetRef` / `counterpart` / `filename`, pinchy-email
 * `messageId` / `attachmentId`, pinchy-web `url`), plus the generic spellings a
 * future tool would use (`id`, `res_id`, `record_id`). `display.test.ts` scans
 * every plugin's declared parameters and fails when a path-, target-, id- or
 * model-like one is missing.
 */
export const TARGET_KEYS: ReadonlySet<string> = new Set([
  "model",
  "ids",
  "id",
  "res_id",
  "record_id",
  "messageId",
  "attachmentId",
  "path",
  "paths",
  "file",
  "filename",
  "url",
  "destination",
  "target",
  "targets",
  "targetRef",
  "counterpart",
]);

/**
 * Rendered first in the summary (so no filler can starve them of the size
 * budget) and never shortened to a preview on the card: they are short, and
 * they are the decision.
 */
export const FULL_VIEW_KEYS: ReadonlySet<string> = new Set([...RECIPIENT_KEYS, ...TARGET_KEYS]);

/** An email address: no whitespace, one `@`, nothing that makes it a list. */
export const EMAIL_SHAPED = /^[^\s@<>,;/]+@([^\s@<>,;/:?#]+)$/u;
/** A URL with an authority: `scheme://[userinfo@]host[:port]…`. The captured
 * host is the one the text READS as; `summary.ts` asks the URL parser for the
 * one it resolves to. */
export const URL_SHAPED = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#\s@]*@)?(\[[^\]]*\]|[^/?#\s:]+)/u;

/** The host note `summary.ts` appends to an address: ` (xn--…)`. */
const HOST_NOTE = / \([^()]*\)$/u;

/**
 * Is this stored value an email address or a URL — the shapes whose host is
 * the decision? The card never shortens one to a preview: a 217-character
 * address whose `@evil.com` sits past the cut reads as the familiar name its
 * local part spells (fourth review of #1242). Tested on the stored text, with
 * the host note the summary may have appended taken off first.
 */
export function isAddressShaped(text: string): boolean {
  const bare = text.replace(HOST_NOTE, "");
  return URL_SHAPED.test(bare) || EMAIL_SHAPED.test(bare);
}

/**
 * A right-to-left character. Every code point Unicode's bidi algorithm reads
 * as right-to-left (classes R and AL) or as an Arabic number (AN) sits in
 * these blocks — unassigned ones included, which default to R or AL there —
 * apart from four explicit controls (U+200F, U+202B, U+202E, U+2067) that the
 * summary shows as `⟨U+XXXX⟩` markers anyway. Checked against Python's
 * `unicodedata` (Unicode 16) over every code point.
 */
const RIGHT_TO_LEFT = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
/** One word, or several joined by plain spaces: letters with their marks. */
const WORDS = /\p{L}[\p{L}\p{M}]*(?: +\p{L}[\p{L}\p{M}]*)*/gu;

/** A piece of one line: a right-to-left `word`, or text held in order. */
export interface OrderedPiece {
  text: string;
  word: boolean;
}

/**
 * How a value is drawn so that what you see is the order it was sent in
 * (eleventh review of #1242). Left to itself, the bidi algorithm draws
 * `/data/חוזים/2024.md` and `/data/2024/חוזים.md` pixel-identically: a digit
 * or a slash next to a right-to-left word joins its run and moves with it.
 * No control character is needed, and both are plain paths — so an injected
 * write to one was approved as the other. Isolating each `/`-separated segment
 * is not enough: `חוזים-2024.md` and `2024-חוזים.md` collide inside one.
 *
 * So everything is held in stored order (an LTR override) except the
 * right-to-left words, each drawn in an isolate of its own so it still reads.
 * A word is letters and marks only, joined by plain spaces — nothing that
 * takes its direction from a neighbour (digits, punctuation) can sit in one —
 * and inside it only its letters' own direction decides the order. So two
 * different texts are never drawn alike, and each word stays readable.
 *
 * One array of pieces per line: a line break ends every override and isolate
 * (it separates bidi paragraphs), so each line is held on its own. `null` for
 * a text with no right-to-left character, where nothing can be reordered: it
 * is drawn as it is.
 */
export function inStoredOrder(text: string): OrderedPiece[][] | null {
  if (!RIGHT_TO_LEFT.test(text)) return null;
  return text.split("\n").map((line) => {
    const pieces: OrderedPiece[] = [];
    let held = 0;
    for (const match of line.matchAll(WORDS)) {
      if (!RIGHT_TO_LEFT.test(match[0])) continue;
      if (match.index > held) pieces.push({ text: line.slice(held, match.index), word: false });
      pieces.push({ text: match[0], word: true });
      held = match.index + match[0].length;
    }
    if (held < line.length || pieces.length === 0) {
      pieces.push({ text: line.slice(held), word: false });
    }
    return pieces;
  });
}

/**
 * `inStoredOrder` in plain text, for the chat-channel prompt: each line in an
 * LTR isolate with an override (U+2066 U+202D … U+202C U+2069, what the card's
 * `<bdo dir="ltr">` is), each right-to-left word in an LTR isolate of its own
 * (U+2066 … U+2069, the card's `<bdi dir="ltr">`). An isolate inside an
 * override is not overridden (UAX #9, X5a), so the word keeps its direction.
 */
export function inStoredOrderPlain(text: string): string {
  const lines = inStoredOrder(text);
  if (!lines) return text;
  return lines
    .map(
      (pieces) =>
        `⁦‭${pieces.map((piece) => (piece.word ? `⁦${piece.text}⁩` : piece.text)).join("")}‬⁩`
    )
    .join("\n");
}

/** Would `text`, printed bare, read as a value of another type? */
function readsAsLiteral(text: string): boolean {
  if (text.trim() === "") return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * One rendering per type, so no value can pass for another: Odoo reads
 * `bool("false")` as True, so on a write the string "false" and the boolean
 * `false` set opposite values. Non-string values print as their JSON literal
 * (`false`, `1`, `null`). A string prints bare — unless, bare, it would read as
 * such a literal (or as nothing at all), in which case it prints quoted. So any
 * bare token that is a JSON literal is never a string.
 */
export function displayScalar(value: unknown): string {
  if (typeof value === "string") return readsAsLiteral(value) ? JSON.stringify(value) : value;
  if (value === undefined) return "null";
  return JSON.stringify(value) ?? String(value);
}

/** The marker the summary appends to a string it cut at the stored limit. */
export function truncationMarker(hidden: number): string {
  return `… [truncated: ${hidden} more characters not shown]`;
}

const TRUNCATION_MARKER = /… \[truncated: \d+ more characters not shown\]$/;

/**
 * Separates the stored truncation marker from the text, so the card can show
 * it outside the collapsible preview. A string that merely ENDS with such a
 * marker is displayed as cut too — a false warning, never a hidden one.
 */
export function splitTruncation(text: string): { text: string; marker: string | null } {
  const match = TRUNCATION_MARKER.exec(text);
  if (!match) return { text, marker: null };
  return { text: text.slice(0, match.index), marker: match[0] };
}

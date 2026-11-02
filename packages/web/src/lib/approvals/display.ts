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
const RIGHT_TO_LEFT =
  /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
/**
 * The characters in those blocks that are strongly right-to-left (bidi class
 * R or AL) without being letters: Hebrew maqaf, geresh and gershayim, the
 * Arabic question mark and full stop, the digits of N'Ko and Adlam, … Taken
 * from Unicode 16.0 (Python's `unicodedata.bidirectional`), every assigned
 * code point in the blocks that is not a letter, a mark or a format character
 * and whose class is R or AL; a range may span letters, which are word
 * characters anyway. `display.test.ts` checks every one of them, and every
 * weaker one (digits, separators, neutrals) that must stay out.
 */
const STRONG_NON_LETTER =
  "\u05BE\u05C0\u05C3\u05C6\u05F3-\u05F4\u0608\u060B\u060D\u061B\u061D-\u061F\u066D\u06D4\u06FD-\u070D\u07C0-\u07C9\u07FE-\u07FF\u0830-\u083E\u085E\u0888\uFBB2-\uFBC2\uFDFC\u{10857}-\u{1087F}\u{108A7}-\u{108AF}\u{108FB}-\u{1091B}\u{1093F}\u{109BC}-\u{109CF}\u{109D2}-\u{109FF}\u{10A40}-\u{10A48}\u{10A50}-\u{10A58}\u{10A7D}-\u{10A9F}\u{10AC8}\u{10AEB}-\u{10AF6}\u{10B58}-\u{10B5F}\u{10B78}-\u{10B7F}\u{10B99}-\u{10B9C}\u{10BA9}-\u{10BAF}\u{10CFA}-\u{10CFF}\u{10D8E}-\u{10D8F}\u{10EAD}\u{10F1D}-\u{10F26}\u{10F51}-\u{10F59}\u{10F86}-\u{10F89}\u{10FC5}-\u{10FCB}\u{1E8C7}-\u{1E8CF}\u{1E950}-\u{1E959}\u{1E95E}-\u{1E95F}\u{1EC71}-\u{1ECB4}\u{1ED01}-\u{1ED3D}";
/** A character a word is made of: a letter, or a strong right-to-left non-letter. */
const WORD_CHAR = `[\\p{L}${STRONG_NON_LETTER}]`;
/** A strongly right-to-left character: a letter of those blocks, or a non-letter above. */
const STRONG_RTL = `(?:(?=${RIGHT_TO_LEFT.source})\\p{L}|[${STRONG_NON_LETTER}])`;
/**
 * A strongly right-to-left character with its marks and a `"` or `'` typed for
 * a gershayim or geresh (`בע"מ`, `ג'ירפה`), when another strongly
 * right-to-left character follows. Between two of them the quote resolves to
 * right-to-left (UAX #9, N1), so inside the word it is ordered like the
 * letters around it; anywhere else it is not, and it stays outside. Written
 * without a lookbehind, which Safari before 16.4 cannot parse.
 */
const QUOTED = `${STRONG_RTL}\\p{M}*["'](?=${STRONG_RTL})`;
const WORD = `(?:${QUOTED}|${WORD_CHAR})(?:${QUOTED}|${WORD_CHAR}|\\p{M})*`;
/** One word, or several joined by plain spaces. */
const WORDS = new RegExp(`${WORD}(?: +${WORD})*`, "gu");

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
 * A word is letters, their marks and the non-letters that are strongly
 * right-to-left themselves (`STRONG_NON_LETTER`: the gershayim of בע״מ), plus
 * a `"` or `'` between two right-to-left characters, which resolves to
 * right-to-left there; words are joined by plain spaces. Nothing that takes
 * its direction from a neighbour (digits, other punctuation) can sit in one,
 * and inside it only its characters' own direction decides the order. So two
 * different texts are never drawn alike, and each word stays readable — a
 * company name `חברה בע״מ` too, which split at its gershayim read garbled
 * (twelfth review of #1242).
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

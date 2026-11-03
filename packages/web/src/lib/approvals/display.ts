/**
 * Display rules shared by the three renderings of a pending confirmation: the
 * stored summary (`summary.ts`), the in-app card (`approval-card.tsx`) and the
 * chat-channel prompt (`prompt.ts`).
 *
 * Import-free on purpose: the card is a Client Component, and `summary.ts`
 * pulls in `node:url`, which must not reach the client bundle. And free of
 * anything whose answer depends on where it runs — a URL parser, a grapheme
 * segmenter: the summary makes those decisions on the server
 * (`presentation.ts`) and stores them, and the card only reads them.
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
 * budget) and drawn whole on the card up to WHOLE_MAX characters, where any
 * other text is previewed past PREVIEW_LEN: they are short, and they are the
 * decision.
 */
export const FULL_VIEW_KEYS: ReadonlySet<string> = new Set([...RECIPIENT_KEYS, ...TARGET_KEYS]);

/**
 * A target or an address is drawn whole on the card up to this many
 * characters, as shown. It holds every real one: pinchy-files caps a path at
 * 1,024 characters, and the widest a character is shown is an
 * eight-character marker (`⟨U+200D⟩`). Past it, the value is previewed like
 * any long text, with the rest revealed a part at a time. Unbounded, it would
 * freeze the approver's tab: Chromium lays out a long mixed-direction text in time that
 * grows faster than its length — 13 s for one 200,000-character value
 * in Chromium. At this size one value lays out in 38–47 ms in headless
 * Chromium for the worst shape measured, 8,192 alternating Hebrew letters and
 * digits (one isolate per letter), against 6–8 ms for a Hebrew or Arabic path
 * of the same length. This bounds one value, not a card: sixty such targets
 * took about a second. DRAW_BUDGET bounds the card, and this bounds each part
 * "Show full text" reveals of a longer text (`shownAs` in `presentation.ts`).
 * Wherever an address is previewed, the summary names its host beside it,
 * since the host sits at the end, behind the preview.
 */
export const WHOLE_MAX = 8_192;

/** Any other text longer than this is previewed, the rest on demand. */
export const PREVIEW_LEN = 200;

/**
 * What drawing one collapsed card may cost, over everything it draws: one for
 * every key, value and note, plus one for each of their characters — a
 * character outside the Basic Multilingual Plane ASTRAL_COST, but for the
 * letter-like ones (`LETTER_LIKE_ASTRAL`). The summary
 * counts it (`drawCost`, on what the card draws: a previewed text by its
 * preview, `drawnOf`) and refuses a call past this bound. The card draws the
 * cuts the summary stored and charged (`Previewed`), and decides none of its
 * own, so the count is one decision in every browser.
 *
 * It counts the card before "Show full text" is clicked, and only then. Behind
 * that button a text of up to 200,000 characters waits, and drawn whole one of
 * alternating Hebrew letters and digits, accepted at a preview cost of 201,
 * blocked Chromium for 13.6–28.7 s, again on every relayout. So the button
 * reveals the text a part at a time, by the same count: a part ends where its
 * characters would cost more than WHOLE_MAX, what one target drawn whole may
 * (`Previewed.parts`), and only one part is on the card at once. Measured on the
 * card itself in headless Chromium (load 10–30): the first two clicks on that
 * text 105–142 ms while the page warms up, every later one 29–41 ms through
 * all 25 parts, and a relayout after the last 2 ms — the card holds one part,
 * so nothing grows. The same card drawing one such target whole: 60 ms.
 *
 * What a character costs the browser varies by orders of magnitude, so a
 * bound on size alone (MAX_TOTAL_CHARS in `summary.ts`) does not bound the
 * time. Measured in headless Chromium on macOS (load 9–16, three runs each),
 * cards within every bound but this one: 500 previews of emoji sequences
 * holding the white flag U+1F3F3 (🏳️‍🌈) 2.10–2.14 s; 2,500 short Arabic or
 * Devanagari values 203–243 ms; sixty 4,096-character targets of alternating
 * Hebrew letters and digits, one isolate per letter, about a second. Counted
 * this way, a unit of the Basic Multilingual Plane costs at most 5–8 µs (an
 * isolate per right-to-left word, a list item per one-letter value); a
 * character outside it up to ~1 ms, 128 times as much: Chromium resolves the
 * font of an emoji or a regional indicator per run, and the white flag or a
 * regional indicator in a value of its own costs about 0.5 ms for each of the
 * two elements it is drawn in (the value and the copy read to assistive
 * technology); the fonts of the CJK extensions and of SignWriting cost as
 * much on first use. Hence ASTRAL_COST — and the letters outside the plane
 * that draw like any other (`LETTER_LIKE_ASTRAL`) cost one.
 *
 * Measured at this bound, same machine and load: 16,374 alternating Hebrew
 * letters and digits in two targets drawn whole (8,187 isolates) 88–138 ms;
 * 126 values of one white flag, or of one regional indicator, 128–140 ms;
 * 8,191 one-letter values 93–101 ms, as many numbers 36–46 ms; 127 flag and
 * rainbow pairs in one target 70–74 ms; Arabic, Devanagari, CJK, combining
 * marks and markers in 81 previews 5–20 ms. Ordinary cards stay far below it
 * and draw in 1–7 ms: a mail with a long body, a 60-field partner write, an
 * invoice of fifty lines, two hundred named recipients, forty chat messages
 * with emoji in them; one address drawn whole at WHOLE_MAX leaves room for as
 * much again.
 *
 * One font is slower than the bound accounts for: Noto Sans SignWriting.
 * 126 SignWriting characters between letters lay out in 1 ms once loaded, but
 * the first draw loads the font (~300 ms, whatever the count), and once
 * Chromium's font cache has dropped it — one card of ~1,700 characters from
 * many other fonts is enough — every run reloads it: 544–597 ms.
 */
export const DRAW_BUDGET = 16_384;

/** What one character outside the Basic Multilingual Plane costs (`DRAW_BUDGET`). */
export const ASTRAL_COST = 128;

/**
 * The ranges outside the Basic Multilingual Plane that cost one, like a
 * letter, and not ASTRAL_COST: an allow-list, so a range nobody has measured
 * keeps the cost that bounds the worst one.
 *
 * Measured per character (headless Chromium and WebKit on macOS, a fresh
 * browser per range), the cost outside the plane is not spread over it.
 * Warm, Chromium spends ~1.1 ms on a value of one regional indicator or one
 * pictograph whose default presentation is text (U+1F3F7 🏷, U+1F5B1 🖱 —
 * 140 code points of U+1F000–U+1FAFF), against 25–50 µs for any other one-
 * character value; WebKit spends nothing extra on either. Cold, the fonts
 * loaded on first use cost per character: CJK Extensions B–G 150–430 µs per
 * distinct ideograph in WebKit and 280–730 µs per value in Chromium,
 * SignWriting ~2.5 ms either way. Everything else measured — Mathematical
 * Alphanumeric Symbols, Egyptian, Cuneiform, Linear B, Gothic, Adlam —
 * draws like the Basic Multilingual Plane, cold and warm: 2–3 µs per
 * character in one run, 40–60 µs per one-character value.
 *
 * Listed is what ordinary work writes: the bold and italic letters of the
 * Mathematical Alphanumeric Symbols (𝐁𝐢𝐠 𝐧𝐞𝐰𝐬), which a post drafted for
 * LinkedIn sets its headings in. At ASTRAL_COST, a value whose first 128
 * characters are such letters would be refused.
 */
const LETTER_LIKE_ASTRAL: ReadonlyArray<readonly [number, number]> = [[0x1d400, 0x1d7ff]];

/** What one character costs to draw: one, or ASTRAL_COST outside the plane but for LETTER_LIKE_ASTRAL. */
function charCost(char: string): number {
  if (char.length === 1) return 1;
  const code = char.codePointAt(0)!;
  return LETTER_LIKE_ASTRAL.some(([low, high]) => code >= low && code <= high) ? 1 : ASTRAL_COST;
}

/**
 * What drawing `text` as one key, value or note costs against DRAW_BUDGET:
 * one for its element, one for each character, ASTRAL_COST for each outside
 * the Basic Multilingual Plane but a letter-like one (`LETTER_LIKE_ASTRAL`).
 * One rule, read by the summary that charges a card and by the card that
 * checks the cuts it was handed (`readNode`).
 */
export function drawCost(text: string): number {
  let cost = 1;
  for (const char of text) cost += charCost(char);
  return cost;
}

/**
 * A text the card previews, and every cut the card makes in it, as the
 * summary decided them (`shownAs` in `presentation.ts`) and charged for. The
 * card reads them and decides nothing: whether a value is a URL, and where a
 * character ends, have different answers in different browsers, and each
 * difference was a card that drew more than the summary charged.
 *
 * - `text`: the value, rendered like any summary string.
 * - `preview`: where the preview ends, as a UTF-16 offset into `text`.
 * - `parts`: where each part "Show full text" reveals ends, in order; the
 *   last is `text.length`.
 * - `inside`: the offsets among those at which the cut falls inside one
 *   character as a person reads it, whose two pieces draw differently than
 *   the whole character.
 */
export interface Previewed {
  "@": "previewed";
  text: string;
  preview: number;
  parts: number[];
  inside: number[];
}

/** A summary text as the card shows it: drawn whole when a string, else previewed. */
export type Shown = string | Previewed;

/**
 * One part of a long text, as the card reveals it after "Show full text".
 * `start` and `end` are UTF-16 offsets into the value's text; `drawn` is that
 * stretch of it as `displayScalar` draws it (escaped, and with the opening or
 * closing quote on the first or last part, where the text is drawn quoted);
 * `first`, `last` and `total` count characters as drawn, from 1.
 * `startsInside` and `endsInside` say that the cut before or after the part
 * falls inside one character (`Previewed.inside`).
 */
export interface TextWindow {
  start: number;
  end: number;
  drawn: string;
  first: number;
  last: number;
  total: number;
  startsInside: boolean;
  endsInside: boolean;
}

/** A text as `displayScalar` draws it, without the quotes around it. */
function escaped(text: string, literal: boolean): string {
  return literal ? JSON.stringify(text).slice(1, -1) : text;
}

/**
 * The stretch of `text` from `start` to `end` as the card draws it: escaped
 * where the text is drawn quoted, with the opening quote where the stretch
 * starts the text and the closing one where it ends it.
 */
function drawnStretch(text: string, start: number, end: number): string {
  const literal = readsAsLiteral(text);
  const open = literal && start === 0 ? '"' : "";
  const close = literal && end === text.length ? '"' : "";
  return `${open}${escaped(text.slice(start, end), literal)}${close}`;
}

/**
 * What the collapsed card draws of a value: the whole text as `displayScalar`
 * shows it, or its preview, without the `…` after it. The summary charges
 * exactly this (`drawCost`), and the card draws exactly this.
 */
export function drawnOf(shown: Shown): string {
  return typeof shown === "string"
    ? displayScalar(shown)
    : drawnStretch(shown.text, 0, shown.preview);
}

/** The whole text of a value, whether it is drawn whole or previewed. */
export function textOf(shown: Shown): string {
  return typeof shown === "string" ? shown : shown.text;
}

/** How many characters (code points) `text` has, without spreading it into an array. */
function codePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += text.codePointAt(i)! > 0xffff ? 2 : 1) count++;
  return count;
}

/** The preview of a previewed text as drawn, how many characters it hides, and whether it ends inside one. */
export function previewOf(node: Previewed): { drawn: string; hidden: number; endsInside: boolean } {
  const drawn = drawnOf(node);
  return {
    drawn,
    hidden: codePoints(displayScalar(node.text)) - codePoints(drawn),
    endsInside: node.inside.includes(node.preview),
  };
}

/** Part `index` of a previewed text, as the summary cut it (`Previewed.parts`). */
export function partOf(node: Previewed, index: number): TextWindow {
  const { text, parts, inside } = node;
  const start = index === 0 ? 0 : parts[index - 1];
  const end = parts[index];
  const drawn = drawnStretch(text, start, end);
  // Drawn quoted, what comes before a later part is the opening quote and the
  // text before it escaped: its JSON string without the closing quote.
  const before =
    readsAsLiteral(text) && start > 0
      ? codePoints(JSON.stringify(text.slice(0, start))) - 1
      : codePoints(text.slice(0, start));
  return {
    start,
    end,
    drawn,
    first: before + 1,
    last: before + codePoints(drawn),
    total: codePoints(displayScalar(text)),
    startsInside: start > 0 && inside.includes(start),
    endsInside: end < text.length && inside.includes(end),
  };
}

/**
 * What Pinchy says ABOUT a value, beside it: the host an address or URL really
 * reaches, that a domain does not parse, or the display name of a recipient.
 */
export type SummaryNote =
  { kind: "host"; host: string } | { kind: "not-a-domain" } | { kind: "name"; name: Shown };

/**
 * A summary value that carries an annotation. Written INTO the value's text —
 * `(record reference: res.partner #7 "Acme GmbH")`, `boss@fіrma.at
 * (xn--frma-l9d.at)` — an annotation reads exactly like a value typed with
 * the same characters; pinchy-odoo resolves a plain string by exact name, so
 * an attacker-made partner of that literal name would get the bill. So every
 * annotation travels out of band, in a node of its own:
 *
 * - `ref`: an opaque record reference that decodes — the value is the record,
 *   and nothing of its text is shown. `label` is cut at 200 characters,
 *   `labelCut` says how many more there were.
 * - `secret`: text under a secret-like key, hidden; only its length is shown.
 * - `noted`: a string value (`text`, rendered like any other, and drawn whole
 *   or previewed as a `Shown`) with what Pinchy says about it (`notes`).
 * - `previewed`: a string value the card previews (`Previewed`).
 *
 * A node is an object with the key `@`, which no summary object can have: a
 * key is labelled bare only when it is `[A-Za-z0-9_.-]+`, and quoted
 * otherwise. A plain string in a summary is always the value's own text and
 * nothing else, drawn whole. Summaries stored before nodes existed hold none,
 * and read as they always did.
 */
export type SummaryNode =
  | { "@": "ref"; model: string; id: number; label: string; labelCut: number }
  | { "@": "secret"; length: number }
  | { "@": "noted"; text: Shown; notes: SummaryNote[] }
  | Previewed;

/** The key that marks a summary node. */
export const NODE_KEY = "@";

function isNote(note: unknown): note is SummaryNote {
  if (!note || typeof note !== "object") return false;
  const { kind, host, name } = note as Record<string, unknown>;
  if (kind === "host") return typeof host === "string";
  if (kind === "name") return readShown(name) !== null;
  return kind === "not-a-domain";
}

/** Is `at` an offset strictly inside `text`, and not between the halves of a surrogate pair? */
function isCut(text: string, at: unknown): at is number {
  if (!Number.isSafeInteger(at)) return false;
  const offset = at as number;
  if (offset <= 0 || offset >= text.length) return false;
  const low = text.charCodeAt(offset);
  const high = text.charCodeAt(offset - 1);
  return !(low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff);
}

/**
 * Does every stretch these cuts draw stay within what the summary's own cuts
 * may draw — the preview at most PREVIEW_LEN characters as drawn, each part
 * at most WHOLE_MAX by `drawCost` — with no cut inside a `⟨…⟩` marker? The
 * summary never stores other cuts (`shownAs` in `presentation.ts`); drawn as
 * stored, other ones would be a card larger, or other, than it charged for.
 */
function cutsFit(text: string, preview: number, parts: number[]): boolean {
  const literal = readsAsLiteral(text);
  const stretch = (start: number, end: number) =>
    `${literal && start === 0 ? '"' : ""}${escaped(text.slice(start, end), literal)}${
      literal && end === text.length ? '"' : ""
    }`;
  if (codePoints(stretch(0, preview)) > PREVIEW_LEN) return false;
  let start = 0;
  for (const end of parts) {
    if (drawCost(stretch(start, end)) - 1 > WHOLE_MAX) return false;
    start = end;
  }
  const cuts = new Set([preview, ...parts]);
  let marker = false;
  for (let at = 0; at < text.length; at++) {
    if (marker && cuts.has(at)) return false;
    const char = text.charAt(at);
    if (char === "⟨") marker = true;
    else if (char === "⟩") marker = false;
  }
  return true;
}

/**
 * Does `node` hold every cut of a `Previewed`, each one inside its text, in
 * order, and drawing no more than the summary's own cuts would (`cutsFit`)?
 */
function isPreviewed(node: Record<string, unknown>): boolean {
  const { text, preview, parts, inside } = node;
  if (typeof text !== "string" || !Array.isArray(parts) || !Array.isArray(inside)) return false;
  const cuts = parts.slice(0, -1);
  return (
    isCut(text, preview) &&
    parts.at(-1) === text.length &&
    cuts.every((at, index) => isCut(text, at) && (index === 0 || at > cuts[index - 1])) &&
    inside.every((at) => at === preview || cuts.includes(at)) &&
    cutsFit(text, preview, parts)
  );
}

/**
 * A summary text as the card can show it, or `null` where it cannot: a plain
 * string is drawn whole, and the summary stores none longer than WHOLE_MAX as
 * drawn — every longer one is `Previewed` — so a longer one, or a previewed
 * node missing a cut, is not guessed at.
 */
export function readShown(value: unknown): Shown | null {
  if (typeof value === "string") {
    return codePoints(displayScalar(value)) <= WHOLE_MAX ? value : null;
  }
  const node = readNode(value);
  return node !== "unreadable" && node?.[NODE_KEY] === "previewed" ? node : null;
}

/**
 * The node a summary value is, `null` for a plain value, or `"unreadable"`
 * for an object marked as a node that this version cannot read (one written
 * by a newer version, say): it must not be drawn as if it were a field list.
 */
export function readNode(value: unknown): SummaryNode | "unreadable" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, NODE_KEY)) return null;
  const node = value as Record<string, unknown>;
  switch (node[NODE_KEY]) {
    case "ref":
      return typeof node.model === "string" &&
        Number.isSafeInteger(node.id) &&
        typeof node.label === "string" &&
        Number.isSafeInteger(node.labelCut)
        ? (node as SummaryNode)
        : "unreadable";
    case "secret":
      return Number.isSafeInteger(node.length) ? (node as SummaryNode) : "unreadable";
    case "previewed":
      return isPreviewed(node) ? (node as unknown as Previewed) : "unreadable";
    case "noted":
      return readShown(node.text) !== null &&
        Array.isArray(node.notes) &&
        node.notes.length > 0 &&
        node.notes.every(isNote)
        ? (node as SummaryNode)
        : "unreadable";
    default:
      return "unreadable";
  }
}

/** A string in double quotes, its `"` and `\` escaped: one token no content
 * can close early. Line breaks stay line breaks. */
export function quoted(text: string): string {
  return `"${text.replace(/["\\]/g, "\\$&")}"`;
}

/** A note as plain text, without its parentheses: `host: "xn--…"`. */
export function noteText(note: SummaryNote): string {
  switch (note.kind) {
    case "host":
      return `host: ${quoted(note.host)}`;
    case "name":
      return `name: ${quoted(textOf(note.name))}`;
    case "not-a-domain":
      return "not a valid domain name";
  }
}

/** A model name as the prompt prints it: bare when it is a plain identifier. */
export function modelText(model: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(model) ? model : quoted(model);
}

/** A record reference as plain text: `(record reference: res.partner #7 "Acme")`. */
export function refText(node: Extract<SummaryNode, { "@": "ref" }>): string {
  const cut = node.labelCut > 0 ? ` … [label cut: ${node.labelCut} more characters not shown]` : "";
  return `(record reference: ${modelText(node.model)} #${node.id} ${quoted(node.label)}${cut})`;
}

/** A hidden secret as plain text. */
export function secretText(node: Extract<SummaryNode, { "@": "secret" }>): string {
  const unit = node.length === 1 ? "character" : "characters";
  return `[secret-like field is being set — value hidden, ${node.length} ${unit}]`;
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
 * How a value is drawn so that what you see is the order it was sent in.
 * Left to itself, the bidi algorithm draws
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
 * company name `חברה בע״מ` too, which split at its gershayim read garbled.
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

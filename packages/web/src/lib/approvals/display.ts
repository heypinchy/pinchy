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
 * budget) and drawn whole on the card up to WHOLE_MAX characters, where any
 * other text is previewed past PREVIEW_LEN: they are short, and they are the
 * decision.
 */
export const FULL_VIEW_KEYS: ReadonlySet<string> = new Set([...RECIPIENT_KEYS, ...TARGET_KEYS]);

/** An email address: no whitespace, one `@`, nothing that makes it a list. */
export const EMAIL_SHAPED = /^[^\s@<>,;/]+@([^\s@<>,;/:?#]+)$/u;

/**
 * A display name and the address in angle brackets after it, as the mail tool
 * accepts one (`parseSingleRecipient` in pinchy-email): quoted, with no `@`,
 * quote, backslash or bracket inside; or bare, with none of the characters
 * that would make it a second mailbox, a comment or a group. No line break
 * either way: a mailbox is one line.
 */
const MAILBOX = /^(?:"[^"\\@<>[\]\p{Cc}]*"\s?|[^<>"@,;:()[\]\\\p{Cc}]*)<([^<>]*)>$/u;

/**
 * The address a value names when the whole value is one mailbox, read the way
 * the mail tool reads it: trimmed, and taken out of `Name <…>`. `null` for
 * anything else — free text that merely holds an address included.
 */
export function mailboxAddress(text: string): string | null {
  const trimmed = text.trim();
  const named = MAILBOX.exec(trimmed);
  const address = named ? named[1].trim() : trimmed;
  return EMAIL_SHAPED.test(address) ? address : null;
}

/** The schemes the URL parser gives a host to, and the only ones a tool fetches. */
const SPECIAL_SCHEMES: ReadonlySet<string> = new Set([
  "ftp:",
  "file:",
  "http:",
  "https:",
  "ws:",
  "wss:",
]);
/** What the URL parser strips from both ends of its input: C0 controls and space. */
const URL_PADDING = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

/** A value the URL parser accepts, as it reads it. */
export interface UrlRead {
  /** The host the parser resolves — the one a tool connects to. */
  host: string;
  /**
   * Does the text show that host, literally, right after `scheme://`, with no
   * userinfo in front of it? Only then does a person read the host the URL
   * reaches.
   */
  showsHost: boolean;
  /** No whitespace once the parser's own padding is stripped: the whole value is the URL. */
  oneToken: boolean;
}

/**
 * Reads `text` as a URL with the parser the tools use (`new URL`, WHATWG) —
 * not with a pattern. The parser accepts far more than `scheme://host`: no
 * slashes (`https:fіrma.at`), one, backslashes, percent-encoding, a leading
 * control character it strips, tabs and line breaks it drops. Every one of
 * those reaches a host the text does not show after `//`. `null` for text the
 * parser refuses, and for a scheme without a host (`mailto:`, `urn:`), which
 * no tool fetches.
 */
export function readUrl(text: string): UrlRead | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!SPECIAL_SCHEMES.has(url.protocol)) return null;
  const stripped = text.replace(URL_PADDING, "");
  const shown = `${url.protocol}//${url.hostname}`;
  // ASCII case only: a non-ASCII letter that lowercases to an ASCII one (the
  // Kelvin sign) is not the letter it imitates.
  const head = stripped.slice(0, shown.length).replace(/[A-Z]/g, (c) => c.toLowerCase());
  const next = stripped.charAt(shown.length);
  return {
    host: url.hostname,
    showsHost:
      !url.username && !url.password && head === shown && (next === "" || "/?#:".includes(next)),
    oneToken: !/\s/u.test(stripped),
  };
}

/**
 * A target or an address is drawn whole on the card up to this many
 * characters, as shown. It holds every real one: pinchy-files caps a path at
 * 1,024 characters, and the widest a character is shown is an
 * eight-character marker (`⟨U+200D⟩`). Past it, the value is previewed like
 * any long text, with the rest revealed a part at a time. Unbounded, it froze the
 * approver's tab: Chromium lays out a long mixed-direction text in time that
 * grows faster than its length — 13 s for one 200,000-character value
 * in Chromium. At this size one value lays out in 38–47 ms in headless
 * Chromium for the worst shape measured, 8,192 alternating Hebrew letters and
 * digits (one isolate per letter), against 6–8 ms for a Hebrew or Arabic path
 * of the same length. This bounds one value, not a card: sixty such targets
 * took about a second. DRAW_BUDGET bounds the card, and this bounds each part
 * "Show full text" reveals of a longer text (`textWindow`). Wherever the card
 * previews an address, the summary names its host beside it (`previewed`),
 * since the host sits at the end, behind the preview.
 */
export const WHOLE_MAX = 8_192;

/** Any other text longer than this is previewed, the rest on demand. */
export const PREVIEW_LEN = 200;

/**
 * Is this value an email address or a URL — the shapes whose host is the
 * decision? The card draws one whole up to WHOLE_MAX: a 217-character address
 * whose `@evil.com` sits past the cut reads as the familiar name its local
 * part spells. Only when the WHOLE value is one:
 * a URL the parser accepts with nothing after it (`readUrl`), or one mailbox
 * (`mailboxAddress`). Free text that merely begins with a URL — "https://…
 * — the new site is live" — is previewed like any text. Tested on the value's
 * own text: the note naming its host is a separate node (`SummaryNode`).
 */
export function isAddressShaped(text: string): boolean {
  return readUrl(text)?.oneToken === true || mailboxAddress(text) !== null;
}

/**
 * Does the card cut this text to a preview, its end behind "Show full text"?
 * `text` is a summary string as stored — markers included — and `full` says
 * whether it sits under a recipient or target key (`FULL_VIEW_KEYS`), at any
 * depth. Counted as drawn: quoted where it would read as a literal
 * (`displayScalar`).
 *
 * The one answer to that question. The card asks it to draw the value; the
 * summary asks it to know when the host a value reaches must be named beside
 * it, since the host sits at the end, where a preview cuts. Each used to ask
 * in its own words — the summary by length alone, the card of the text as
 * drawn — and where they disagreed a URL or address was previewed with no
 * host named: one ending in `⟨4 × U+200B⟩` (a marker with spaces in it, so
 * not one token), one that reads as a JSON string and grows by its quotes,
 * one the URL parser accepts with words after it.
 */
export function previewed(text: string, full: boolean): boolean {
  const length = [...displayScalar(text)].length;
  if (length <= PREVIEW_LEN) return false;
  return !((full || isAddressShaped(text)) && length <= WHOLE_MAX);
}

/**
 * What drawing one collapsed card may cost, over everything it draws: one for
 * every key, value and note, plus one for each of their characters — a
 * character outside the Basic Multilingual Plane ASTRAL_COST. The summary
 * counts it (`drawCost`, on what the card draws: a previewed text by the code
 * points any browser's preview of it may draw, `chargedText`) and refuses a
 * call past this bound; the card draws no more than the summary accepted, so
 * the count is one decision.
 *
 * It counts the card before "Show full text" is clicked, and only then. Behind
 * that button a text of up to 200,000 characters waits, and drawn whole one of
 * alternating Hebrew letters and digits, accepted at a preview cost of 201,
 * blocked Chromium for 13.6–28.7 s, again on every relayout. So the button
 * reveals the text a part at a time, by the same count: a part ends where its
 * characters would cost more than WHOLE_MAX, what one target drawn whole may
 * (`textWindow`), and only one part is on the card at once. Measured on the
 * card itself in headless Chromium (load 10–30): the first two clicks on that
 * text 105–142 ms while the page warms up, every later one 29–41 ms through
 * all 25 parts, and a relayout after the last 2 ms — the card holds one part,
 * so nothing grows. The same card drawing one such target whole: 60 ms.
 *
 * What a character costs the browser varies by orders of magnitude, so a
 * bound on size alone (MAX_TOTAL_CHARS in `summary.ts`) did not bound the
 * time. Measured in headless Chromium on macOS (load 9–16, three runs each),
 * cards the gate accepted before this bound: 500 previews of emoji sequences
 * holding the white flag U+1F3F3 (🏳️‍🌈) 2.10–2.14 s; 2,500 short Arabic or
 * Devanagari values 203–243 ms; sixty 4,096-character targets of alternating
 * Hebrew letters and digits, one isolate per letter, about a second. Counted
 * this way, a unit of the Basic Multilingual Plane costs at most 5–8 µs (an
 * isolate per right-to-left word, a list item per one-letter value); a
 * character outside it up to ~1 ms, 128 times as much: Chromium resolves the
 * font of an emoji, a regional indicator, an ideograph of the CJK extensions
 * or a historic script per run, and the white flag or a regional indicator in
 * a value of its own costs about 0.5 ms for each of the two elements it is
 * drawn in (the value and the copy read to assistive technology). Hence
 * ASTRAL_COST.
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
 * What drawing `text` as one key, value or note costs against DRAW_BUDGET:
 * one for its element, one for each character, ASTRAL_COST for each outside
 * the Basic Multilingual Plane.
 */
export function drawCost(text: string): number {
  let cost = 1;
  for (const char of text) cost += char.length > 1 ? ASTRAL_COST : 1;
  return cost;
}

/**
 * What the collapsed card draws of `text` — a value, or a display name beside
 * one: the whole text as `displayScalar` shows it, or its preview where the
 * card previews it (`previewed`).
 */
export function drawnText(text: string, full: boolean): string {
  const shown = displayScalar(text);
  return previewed(text, full) ? previewOf(shown) : shown;
}

/**
 * What the summary charges for drawing `text` (`drawCost`): the whole text as
 * `displayScalar` shows it, or, where the card previews it, its first
 * PREVIEW_LEN code points, uncut. Not `drawnText`, which cuts the preview back
 * to where a character begins — and where that is depends on the browser
 * (`characters`). Charged by the server's cut, one character of an emoji and
 * 250 skin tones cost 2 as the preview `é`, while a browser without
 * Intl.Segmenter drew 200 code points of it, at 25,474; a card of fifty such
 * values took 5 s to draw there. Every preview is a prefix of these code
 * points, in every browser, so what this costs bounds what any card draws.
 */
export function chargedText(text: string, full: boolean): string {
  const shown = displayScalar(text);
  return previewed(text, full) ? shown.slice(0, previewLimit(shown)) : shown;
}

/** The offset after the first PREVIEW_LEN code points of `text`, or its length. */
function previewLimit(text: string): number {
  let limit = 0;
  for (let count = 0; count < PREVIEW_LEN && limit < text.length; count++) {
    limit += text.codePointAt(limit)! > 0xffff ? 2 : 1;
  }
  return limit;
}

/**
 * The preview of `text`: its first PREVIEW_LEN characters (code points), cut
 * back to a boundary between two characters as a person reads them, and never
 * inside a `⟨…⟩` marker (`partEnd`). Cut by code point, the preview of `Café`
 * ended `Cafe`, and of a flag in a lone regional indicator: a letter or a sign
 * the value does not contain there. Never longer than those code points
 * (`chargedText`); where no boundary is known among them, cut inside a
 * character, which the card then says (`previewEndsInside`).
 */
export function previewOf(text: string): string {
  const limit = previewLimit(text);
  if (limit >= text.length) return text;
  return text.slice(0, partEnd(text, 0, limit, characters(text), false));
}

/**
 * Does the preview of `text` (`previewOf`) end where it cannot tell that a
 * character ends — inside one character as a person reads them? Then its last
 * piece draws differently than the whole character, as a part's does
 * (`TextWindow.endsInside`): one character longer than the preview, thousands
 * of accents on one letter, or, in a browser without Intl.Segmenter, a cut
 * among characters it cannot tell apart.
 */
export function previewEndsInside(text: string): boolean {
  const end = previewOf(text).length;
  return end < text.length && !characters(text).startsAt(end);
}

/**
 * One part of a long text, as the card reveals it after "Show full text".
 * `start` and `end` are UTF-16 offsets into the value's text; `drawn` is that
 * stretch of it as `displayScalar` draws it (escaped, and with the opening or
 * closing quote on the first or last part, where the text is drawn quoted);
 * `first`, `last` and `total` count characters as drawn, from 1.
 * `startsInside` and `endsInside` say that the cut before or after the part
 * may fall inside one character as a person reads it (`textWindow`), which
 * then draws differently on either side of it.
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

/** Absent before Firefox 125 (`characters`). */
const GRAPHEMES =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Nothing is drawn across these: no letter joins, no mark or flag reaches over one. */
const SPACING = new Set([" ", "\t", "\n"]);
/**
 * What belongs to the character in front of it, whatever that is (UAX #29
 * GB9, GB9a): marks, joiners, skin tones, and Thai and Lao AM.
 */
const CLINGS = /^[\p{M}\p{Grapheme_Extend}\p{Emoji_Modifier}\u200C\u200D\u0E33\u0EB3]/u;
/** Printable ASCII: nothing after one belongs to it but what CLINGS. */
const ASCII = /^[\x20-\x7E]$/;

/** Where the characters of a text, as a person reads them, begin. */
interface Characters {
  /** Does a character begin at offset `at` (0 < at < length)? */
  startsAt(at: number): boolean;
  /** The last offset after `floor` and at or before `at` where one begins, or -1. */
  lastStart(at: number, floor: number): number;
}

/**
 * The characters of `text` as a person reads them: its grapheme clusters
 * (UAX #29), read with the WHOLE text — never with a part of it. Whether two
 * regional indicators are one flag depends on how many stand before them in
 * their run, wherever before the part it began.
 *
 * Without Intl.Segmenter (Firefox before 125) a character is known to begin
 * only where the text around it shows it: after or before a line break or
 * tab, and after a printable ASCII character — a space included — unless what
 * follows CLINGS to it. Anywhere else it may or may not.
 */
function characters(text: string): Characters {
  if (GRAPHEMES) {
    const segments = GRAPHEMES.segment(text);
    return {
      startsAt: (at) => segments.containing(at)!.index === at,
      lastStart(at, floor) {
        const index = segments.containing(at)!.index;
        return index > floor ? index : -1;
      },
    };
  }
  const startsAt = (at: number) => {
    const before = text.charAt(at - 1);
    const after = text.charAt(at);
    if (before === "\n" || before === "\t" || after === "\n" || after === "\t") return true;
    return ASCII.test(before) && !CLINGS.test(text.slice(at, at + 2));
  };
  return {
    startsAt,
    lastStart(at, floor) {
      for (; at > floor; at--) if (startsAt(at)) return at;
      return -1;
    },
  };
}

/** Is offset `at` inside a `⟨…⟩` marker? Every `⟨` opens one Pinchy wrote. */
function insideMarker(text: string, at: number): boolean {
  const open = text.lastIndexOf("⟨", at - 1);
  return open !== -1 && text.slice(open, at).indexOf("⟩") === -1;
}

/** Is the code point at `at` a regional indicator — half of a flag? */
function isIndicator(text: string, at: number): boolean {
  const code = text.codePointAt(at)!;
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

/**
 * Where a stretch of `text` from `start` that may reach as far as `limit`
 * (start < limit < text.length) ends. THE RULE: a cut changes nothing about
 * how the text on either side of it is drawn — each side draws exactly the
 * characters the whole text draws there, so what the parts show, one after
 * the other, is what the whole shows, and no part shows a sign the whole does
 * not. Cut between the two regional indicators of a flag, the next part
 * paired every later indicator with the wrong partner: 🇦🇹🇩🇪🇺🇸 read 🇹🇩 (Chad),
 * 🇪🇺 and a lone S. So a stretch ends:
 *
 * 1. with `afterSpace`, after the last space, tab or line break that fits:
 *    nothing is drawn across one — no Arabic letter joins over it, no
 *    conjunct, accent or flag reaches over it. A cut inside a word changes
 *    the forms of the letters at it.
 * 2. Else between two characters as a person reads them (`characters`): a
 *    flag and its two indicators, a letter and its accents, a Hangul syllable
 *    and its jamo, a conjunct, an emoji with its skin tone stay together, as
 *    the whole text has them. Only a word longer than a part is cut here, and
 *    letters that join across the cut, as Arabic ones do, take the forms they
 *    have where a word ends and begins: the same letters, with the card's `…`
 *    beside them saying the word goes on.
 * 3. Else — one character alone costs more than a part, thousands of accents
 *    on one letter — inside it, at the last code point that fits, and never
 *    between the two indicators of a flag: it counts the indicators back to
 *    the start of their run, before `start` too, so the ones after the cut
 *    pair as they do in the whole text. Its two pieces still draw differently
 *    from the whole character, so the card says so (`TextWindow.endsInside`).
 *
 * Never inside a `⟨…⟩` marker. Right-to-left words need nothing here: the
 * card draws one part at a time, each held in stored order on its own
 * (`inStoredOrder`), so no reordering reaches across a cut.
 */
function partEnd(
  text: string,
  start: number,
  limit: number,
  chars: Characters,
  afterSpace: boolean
): number {
  if (afterSpace) {
    for (let at = limit; at > start; at--) {
      const spaced = SPACING.has(text.charAt(at - 1));
      if (spaced && chars.startsAt(at) && !insideMarker(text, at)) return at;
    }
  }
  for (let at = chars.lastStart(limit, start); at > start; at = chars.lastStart(at - 1, start)) {
    if (!insideMarker(text, at)) return at;
  }
  let end = limit;
  const open = text.lastIndexOf("⟨", end - 1);
  if (open > start && insideMarker(text, end)) end = open;
  let indicators = 0;
  while (end - 2 * indicators >= 2 && isIndicator(text, end - 2 * indicators - 2)) indicators++;
  return indicators % 2 === 1 && end - 2 > start ? end - 2 : end;
}

/**
 * The part of `text` the card draws from offset `start` (the end of the part
 * before, or 0): as much as one target drawn whole may cost, its characters
 * at most WHOLE_MAX (`drawCost`). Drawn whole, one 200,000-character value of
 * alternating Hebrew letters and digits blocked Chromium for 13–28 s, and
 * again on every relayout; the preview was within DRAW_BUDGET, the text behind
 * "Show full text" was not.
 *
 * Where a part ends is `partEnd`: after a space where one fits, else between
 * two characters as a person reads them, and inside one only where it alone
 * costs more than a part — which the part then says. Never inside a `⟨…⟩`
 * marker, nor inside an escape of a text drawn quoted, which is escaped per
 * code point. The parts, drawn one after the other, are `displayScalar(text)`.
 */
export function textWindow(text: string, start: number): TextWindow {
  const literal = displayScalar(text) !== text;
  let budget = WHOLE_MAX - (literal ? 2 : 0);
  let end = start;
  while (end < text.length) {
    const width = text.codePointAt(end)! > 0xffff ? 2 : 1;
    const cost = drawCost(escaped(text.slice(end, end + width), literal)) - 1;
    if (cost > budget && end > start) break;
    budget -= cost;
    end += width;
  }
  const chars = characters(text);
  if (end < text.length) end = partEnd(text, start, end, chars, true);
  const drawn = `${literal && start === 0 ? '"' : ""}${escaped(text.slice(start, end), literal)}${
    literal && end === text.length ? '"' : ""
  }`;
  // Drawn quoted, what comes before a later part is the opening quote and the
  // text before it escaped: its JSON string without the closing quote.
  const before =
    literal && start > 0
      ? codePoints(JSON.stringify(text.slice(0, start))) - 1
      : codePoints(text.slice(0, start));
  return {
    start,
    end,
    drawn,
    first: before + 1,
    last: before + codePoints(drawn),
    total: codePoints(displayScalar(text)),
    startsInside: start > 0 && !chars.startsAt(start),
    endsInside: end < text.length && !chars.startsAt(end),
  };
}

/** How many characters (code points) `text` has, without spreading it into an array. */
function codePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += text.codePointAt(i)! > 0xffff ? 2 : 1) count++;
  return count;
}

/**
 * What Pinchy says ABOUT a value, beside it: the host an address or URL really
 * reaches, that a domain does not parse, or the display name of a recipient.
 * `not-a-url` is no longer written — a value the URL parser refuses is not a
 * URL, and no tool fetches it — but summaries stored before still carry it.
 */
export type SummaryNote =
  | { kind: "host"; host: string }
  | { kind: "not-a-url" }
  | { kind: "not-a-domain" }
  | { kind: "name"; name: string };

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
 * - `noted`: a string value (`text`, rendered like any other) with what
 *   Pinchy says about it (`notes`).
 *
 * A node is an object with the key `@`, which no summary object can have: a
 * key is labelled bare only when it is `[A-Za-z0-9_.-]+`, and quoted
 * otherwise. A plain string in a summary is always the value's own text and
 * nothing else. Summaries stored before nodes existed hold none, and read as
 * they always did.
 */
export type SummaryNode =
  | { "@": "ref"; model: string; id: number; label: string; labelCut: number }
  | { "@": "secret"; length: number }
  | { "@": "noted"; text: string; notes: SummaryNote[] };

/** The key that marks a summary node. */
export const NODE_KEY = "@";

function isNote(note: unknown): note is SummaryNote {
  if (!note || typeof note !== "object") return false;
  const { kind, host, name } = note as Record<string, unknown>;
  if (kind === "host") return typeof host === "string";
  if (kind === "name") return typeof name === "string";
  return kind === "not-a-url" || kind === "not-a-domain";
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
    case "noted":
      return typeof node.text === "string" &&
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
      return `name: ${quoted(note.name)}`;
    case "not-a-url":
      return "not a valid URL";
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

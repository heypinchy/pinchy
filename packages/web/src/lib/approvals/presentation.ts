/**
 * Every decision about how the card presents a text, made once, on the
 * server, while the summary is built: whether a value is drawn whole or
 * previewed, where its preview ends, and where each part "Show full text"
 * reveals ends. The summary charges the draw budget for exactly those cuts and
 * stores them in the value's node (`Previewed` in `display.ts`); the card
 * draws what the node says and decides nothing.
 *
 * Both questions need knowledge that differs between environments. Whether a
 * value is a URL is answered by a URL parser, and Chromium's and WebKit's
 * accept hosts Node's refuses (`xn--a`, any invalid punycode label); where a
 * character ends is answered by Intl.Segmenter, which browsers before Firefox
 * 125 lack. Asked in the approver's browser, every such difference is a card
 * that draws more than the summary charged — a value priced as a 200-character
 * preview, drawn whole at 8,000 characters. Asked here, there is one answer:
 * Node's, which is also the parser the tools that fetch a URL use.
 */
import {
  PREVIEW_LEN,
  WHOLE_MAX,
  displayScalar,
  drawCost,
  type Previewed,
  type Shown,
} from "./display";

/** An email address: no whitespace, one `@`, nothing that makes it a list. */
const EMAIL_SHAPED = /^[^\s@<>,;/]+@([^\s@<>,;/:?#]+)$/u;

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
 * Reads `text` as a URL with the parser the tools use (`new URL`, WHATWG, as
 * Node implements it) — not with a pattern. The parser accepts far more than
 * `scheme://host`: no slashes (`https:fіrma.at`), one, backslashes,
 * percent-encoding, a leading control character it strips, tabs and line
 * breaks it drops. Every one of those reaches a host the text does not show
 * after `//`. `null` for text the parser refuses, and for a scheme without a
 * host (`mailto:`, `urn:`), which no tool fetches.
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
 * Is this value an email address or a URL — the shapes whose host is the
 * decision? Such a value is drawn whole up to WHOLE_MAX: a 217-character
 * address whose `@evil.com` sits past the cut reads as the familiar name its
 * local part spells. Only when the WHOLE value is one: a URL the parser
 * accepts with nothing after it (`readUrl`), or one mailbox
 * (`mailboxAddress`). Free text that merely begins with a URL — "https://… —
 * the new site is live" — is previewed like any text. Tested on the value's
 * own text: the note naming its host is a separate node (`SummaryNode`).
 */
export function isAddressShaped(text: string): boolean {
  return readUrl(text)?.oneToken === true || mailboxAddress(text) !== null;
}

/**
 * Is this text previewed, its end behind "Show full text"? `text` is a summary
 * string as stored — markers included — and `full` says whether it sits under
 * a recipient or target key (`FULL_VIEW_KEYS`), at any depth. Counted as
 * drawn: quoted where it would read as a literal (`displayScalar`). Any text
 * longer than PREVIEW_LEN is; a target, a recipient or an address only past
 * WHOLE_MAX.
 */
export function previewed(text: string, full: boolean): boolean {
  const length = [...displayScalar(text)].length;
  if (length <= PREVIEW_LEN) return false;
  return !((full || isAddressShaped(text)) && length <= WHOLE_MAX);
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Nothing is drawn across these: no letter joins, no mark or flag reaches over one. */
const SPACING = new Set([" ", "\t", "\n"]);

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
 */
function characters(text: string): Characters {
  const segments = GRAPHEMES.segment(text);
  return {
    startsAt: (at) => segments.containing(at)!.index === at,
    lastStart(at, floor) {
      const index = segments.containing(at)!.index;
      return index > floor ? index : -1;
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
 * not. A cut between the two regional indicators of a flag would pair every
 * later indicator with the wrong partner: 🇦🇹🇩🇪🇺🇸 would read 🇹🇩 (Chad), 🇪🇺
 * and a lone S. So a stretch ends:
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
 *    from the whole character, so the node records the cut as `inside`.
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

/** A text as `displayScalar` draws it, without the quotes around it. */
function escaped(text: string, literal: boolean): string {
  return literal ? JSON.stringify(text).slice(1, -1) : text;
}

/**
 * The offset as far as which the code points of `text` from `start` fit in
 * `budget`, each costing `cost` of its drawn form — at least one code point,
 * so a stretch never comes out empty. Escaped per code point, so no cut falls
 * inside an escape of a text drawn quoted.
 */
function fit(
  text: string,
  start: number,
  budget: number,
  literal: boolean,
  cost: (drawn: string) => number
): number {
  let end = start;
  while (end < text.length) {
    const width = text.codePointAt(end)! > 0xffff ? 2 : 1;
    const spent = cost(escaped(text.slice(end, end + width), literal));
    if (spent > budget && end > start) break;
    budget -= spent;
    end += width;
  }
  return end;
}

/**
 * The text as the card shows it (`Shown`): the string itself where it is
 * drawn whole, or a `Previewed` node with every cut the card makes in it.
 *
 * - The preview is as much of the text as PREVIEW_LEN characters drawn hold
 *   (the opening quote of a text drawn quoted counts), cut back to a boundary
 *   between two characters as a person reads them (`partEnd`), so the preview
 *   of `Café` never ends `Cafe`, nor a flag in a lone regional indicator.
 * - Each part "Show full text" reveals is as much as one target drawn whole
 *   may cost, its characters at most WHOLE_MAX (`drawCost`), ending after a
 *   space where one fits. Drawn whole, one 200,000-character value of
 *   alternating Hebrew letters and digits blocked Chromium for 13–28 s, and
 *   again on every relayout.
 * - `inside` names every one of those cuts that falls inside one character —
 *   a character that alone costs more than the preview or a part — since its
 *   two pieces draw differently than the whole character, and the card says
 *   so.
 *
 * A text whose preview would hold all of it — one that grows past PREVIEW_LEN
 * only by the closing quote it is drawn with — is drawn whole.
 */
export function shownAs(text: string, full: boolean): Shown {
  if (!previewed(text, full)) return text;
  const literal = displayScalar(text) !== text;
  const quotes = literal ? 1 : 0;
  const limit = fit(text, 0, PREVIEW_LEN - quotes, literal, (drawn) => [...drawn].length);
  if (limit >= text.length) return text;
  const chars = characters(text);
  const preview = partEnd(text, 0, limit, chars, false);
  const parts: number[] = [];
  for (let start = 0; start < text.length; start = parts[parts.length - 1]) {
    const end = fit(text, start, WHOLE_MAX - 2 * quotes, literal, (drawn) => drawCost(drawn) - 1);
    parts.push(end < text.length ? partEnd(text, start, end, chars, true) : end);
  }
  const cuts = new Set([preview, ...parts.slice(0, -1)]);
  const inside = [...cuts].filter((at) => !chars.startsAt(at)).sort((a, b) => a - b);
  return { "@": "previewed", text, preview, parts, inside } satisfies Previewed;
}

/**
 * Build the human-readable rendering of tool-call arguments for the
 * confirmation card. This is OPERATIONAL data (stored on the tool_approval
 * row, shown to the approving user so they can decide in context) — it is
 * deliberately NOT written into the audit log, where only the PII-free
 * argsDigest is recorded.
 *
 * THE RULE: the approver must be able to see every security-relevant value the
 * tool will receive. The digest binds the full arguments, but a digest nobody
 * can read approves nothing — if this summary is lossy, the person clicks
 * "Approve" on a view that differs from what runs. An earlier version cut
 * strings at 200 characters and printed arrays as "[3 items]" and objects as
 * "{2 fields}", which let a prompt-injected agent hide a second recipient
 * behind 200 spaces, and bank details behind "{2 fields}".
 *
 * So this summary keeps the structure and the content. Where it has to stop —
 * past a size, width or depth bound — it says so with an explicit "… not
 * shown" marker, AND it reports the call as `incomplete` (`summarizeCall`).
 * The gate refuses an incomplete call instead of opening a confirmation for
 * it (third review of #1242): a marker is honest, but a person who clicks
 * "Approve" on "1 more field not shown" still approves the field. The bounds
 * are sized so ordinary work — an Odoo invoice with dozens of lines, a long
 * mail body, a report written to a file — fits whole; only an oversized call
 * is refused, and the agent is told which bound it crossed (`exceeded`,
 * `describeRefusal`), and to split the call only where splitting can help.
 *
 *
 * - Strings are kept as sent — never trimmed or whitespace-collapsed, since a
 *   rewritten value is not the value that runs. The card renders them with
 *   `white-space: pre-wrap`. What could hide text is made visible instead:
 *   every character that renders as nothing or as blank space without being a
 *   plain space, tab or line break — controls, format characters (`Cf`: bidi
 *   overrides, zero-width, Unicode tag characters), every other space
 *   separator (no-break, ideographic, …), variation selectors and the other
 *   default-ignorables (Hangul fillers), and the braille blank U+2800 — is
 *   shown as a `⟨U+XXXX⟩` marker, and so is a lone UTF-16 surrogate (which
 *   Postgres would refuse to store in jsonb). A run of more than three of
 *   one character is shown as a count (`⟨180 × U+2800⟩`); a mixed run names
 *   every character, so no two runs read alike. A CRLF is a line
 *   break like LF; a lone CR stays escaped. A run of four or more
 *   spaces, line breaks or tabs is shown as `⟨N spaces⟩` / `⟨N line breaks⟩` /
 *   `⟨N tabs⟩`, so padding cannot push text out of view. U+200C / U+200D
 *   (the joiners) and U+FE0E / U+FE0F (text / emoji presentation) are marked
 *   everywhere — "Noack\u200D GmbH" must not read as "Noack GmbH" (sixth
 *   review of #1242), nor `க்\u200Cம.md` as `க்ம.md` (tenth), nor
 *   `❤️\u200D🔥.md` as `❤️🔥.md`: whether a joiner draws anything, in a script
 *   or inside an emoji, depends on the approver's font, which the server
 *   cannot know — Windows 10 draws ❤️‍🔥 as two glyphs (eleventh). A literal
 *   `⟨` or `⟩` is marked too (`⟨U+27E8⟩`), so a value cannot type a marker
 *   that reads as a real one (twelfth): every `⟨` opens a marker. Where an
 *   action lands (`TARGET_KEYS`: a path, a file name, a record), a value names
 *   one target and two that render alike are two targets, so a space, tab or
 *   line break at its start or end is marked too.
 *   Strings are kept whole
 *   up to MAX_STRING_LEN characters as SENT — the markers a text is shown with
 *   do not count against that, only against the total — and the card shows a
 *   preview and the full text on demand. A cut never lands between the two
 *   halves of a surrogate pair.
 * - Keys are never merged. A key that is not a plain identifier is shown
 *   quoted and escaped, so `"to "` (trailing space) is its own row next to
 *   `to` — trimming it into `to` once let a second, look-alike key overwrite
 *   the row the tool actually reads. Labels are unique by construction.
 * - Arrays and objects keep their actual contents, to a bounded depth, width
 *   and total size. Anything cut off is replaced by an explicit "… not shown"
 *   marker, so a reader can tell that something was left out.
 * - What the summary says ABOUT a value — the record a ref names, the host an
 *   address reaches, a recipient's display name, that a secret is being set —
 *   is a node of its own (`SummaryNode` in `display.ts`), never text written
 *   into the value: written in, it read exactly like a value typed with the
 *   same characters (fourteenth review of #1242). A plain string in the
 *   summary is always the value's own text.
 * - Recipients (`to` / `cc` / `bcc`) are split into an explicit address list,
 *   one entry each, so a comma-smuggled extra address is a visible line. Each
 *   entry is the address, with the display name as a note beside it, so a long
 *   familiar name cannot push the real address out of view, and a non-ASCII
 *   domain is named in punycode too, so a homoglyph domain reads as the
 *   different domain it is. The same goes for ANY value that is shaped like an
 *   email address or a URL, at any key and depth — an Odoo `values.email` or
 *   `website` deceives the same way a `to` does. A URL's host is the one the
 *   WHATWG parser resolves — what the tool connects to — and it is named
 *   whenever it differs from the host the text reads as. Recipient and target keys
 *   (`FULL_VIEW_KEYS`) are
 *   rendered before anything else, so no filler in front of them can starve
 *   them of the size budget or push them past MAX_KEYS.
 * - An opaque record reference names the record it points at — model, id and
 *   label — when it decodes. A string that does not decode is shown as the
 *   text it is: free text that merely starts with the ref prefix is still free
 *   text, and hiding it would hide an email body.
 *
 * Text under a secret-looking key stays hidden at any depth, so a leaked
 * summary never exposes a token — but the row says that a secret-like field is
 * being SET, and how long the value is, because an attacker-chosen token
 * written into a record is an effect the approver has to see. Only TEXT is
 * hidden: a number, boolean or null cannot carry a credential, a key ending in
 * `_id` / `_ids` holds record ids (`payment_token_id: 7`), and an object or
 * list under a secret-like key is shown field by field with every text in it
 * hidden (fourth review of #1242). The recipient and subject of an email ARE
 * kept — hiding them would defeat the point of an informed confirmation.
 */
import { domainToASCII } from "node:url";
import { isCanonicalRef, type RefRecord } from "./call-models";
import {
  EMAIL_SHAPED,
  FULL_VIEW_KEYS,
  TARGET_KEYS,
  URL_SHAPED,
  WHOLE_MAX,
  noteText,
  refText,
  secretText,
  truncationMarker,
  type SummaryNode,
  type SummaryNote,
} from "./display";

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
/** A record id or a list of them, whatever the rest of the key says. */
const RECORD_ID_KEY = /_ids?$/i;
const RECIPIENT_KEY = /^(to|cc|bcc)$/i;

/*
 * The bounds. Crossing any of them makes the call `incomplete`, and the gate
 * refuses it, so they are sized for real work rather than for a tidy card:
 * an Odoo record carries a few dozen fields (`res.partner` writes of 30–60 are
 * ordinary), an invoice create a few dozen line commands, a mail body a few
 * pages, a file written by `pinchy_write` a report of a few dozen pages. The
 * card scrolls (`max-h-64 overflow-y-auto`) and previews long text, so a
 * large summary stays usable.
 *
 * Size: every value is charged against MAX_TOTAL_CHARS as it is SHOWN — a
 * string by its rendered length (markers included), a key by its label, a
 * number, boolean or null by its JSON length, and every array or object 2 —
 * so the summary's JSON is the budget plus quoting and separators: at most
 * about twice MAX_TOTAL_CHARS (one-digit numbers, `"`-heavy text) and close to
 * it for ordinary text, i.e. a jsonb row of 0.5–1 MB in the worst case, and
 * up to ~1.5 MB of UTF-8 for non-Latin text. The inbox poll lists every
 * pending card — MAX_PENDING_PER_REQUESTER (20) per agent, so a person using
 * several agents may have more — but sends each summary once: a poll names the
 * cards it already holds (`known`, up to MAX_KNOWN_APPROVALS) and gets those
 * back without their summary.
 */
/** Longest string stored whole, in characters as sent (code points): a
 * report of ~60 pages, or a long mail body with room to spare. */
const MAX_STRING_LEN = 200_000;
const MAX_KEYS = 100;
const MAX_ITEMS = 200;
/** Deep enough for an Odoo invoice: values → invoice_line_ids → [0, 0, {…}] →
 * tax_ids → [6, 0, [ids]] sits at depth 7. MAX_TOTAL_CHARS bounds the size. */
const MAX_DEPTH = 10;
/** Total characters one summary may show, everything counted (see above) —
 * keeps the jsonb row, and the poll response that carries it, bounded. */
const MAX_TOTAL_CHARS = 512_000;
/** Longest key (in code points) rendered; a longer one is cut and says so. */
const MAX_KEY_LEN = 100;
/** Longest record label rendered for a reference. */
const MAX_REF_LABEL_LEN = 200;
/** A run of one invisible character longer than this is shown as a count. */
const MAX_ESCAPED_RUN = 3;
/** A run of this many spaces, line breaks or tabs is shown as a count. */
const MIN_LAYOUT_RUN = 4;

export interface SummarizeOptions {
  /** Resolves an opaque record reference to the record it points at. */
  refRecord?: (ref: string) => RefRecord | null;
}

/**
 * The first bound a call crossed, and where — so the refusal can say what
 * was too large instead of a blanket "split it". `at` is the path of the
 * value (`values.comment`, `lines[1].note`), built from the same escaped key
 * labels the card shows.
 */
export type SummaryLimit =
  | { kind: "text-too-long"; at: string; length: number; limit: number }
  | { kind: "key-too-long"; at: string; length: number; limit: number }
  | { kind: "too-many-fields"; at: string; count: number; limit: number }
  | { kind: "too-many-items"; at: string; count: number; limit: number }
  | { kind: "too-many-recipients"; at: string; count: number; limit: number }
  | { kind: "nested-too-deep"; at: string; limit: number }
  | { kind: "too-large-in-all"; limit: number };

interface Budget {
  chars: number;
  refRecord?: (ref: string) => RefRecord | null;
  /** The first bound crossed; set as soon as anything is dropped or cut. */
  exceeded: SummaryLimit | null;
}

function exceed(budget: Budget, limit: SummaryLimit): void {
  budget.exceeded ??= limit;
}

const TOO_LARGE_IN_ALL: SummaryLimit = { kind: "too-large-in-all", limit: MAX_TOTAL_CHARS };

/** What the confirmation card stores, and whether it is the whole call. */
export interface CallSummary {
  summary: Record<string, unknown>;
  /**
   * True when any part of the call did not fit — a key past MAX_KEYS, an item
   * past MAX_ITEMS, nesting past MAX_DEPTH, a string or key cut, the total
   * budget spent. Such a call must not be offered for approval: the person
   * would approve the part they cannot see.
   */
  incomplete: boolean;
  /** Which bound made it incomplete; null when the call fits. */
  exceeded: SummaryLimit | null;
}

/**
 * Renders as nothing or as blank space: controls, every format character
 * (bidi, zero-width, tags, U+FFF9–FFFB, …), every space separator, line and
 * paragraph separators, every default-ignorable code point (variation
 * selectors, Hangul fillers, the combining grapheme joiner, …) and the
 * braille blank — and a lone UTF-16 surrogate, which renders as nothing
 * readable and which Postgres refuses inside jsonb. The same set the write
 * tools refuse (`hidden-chars.ts` in pinchy-email / pinchy-files;
 * `hidden-chars-drift.test.ts` pins the two, and the deliberate exceptions).
 */
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Z}\p{Default_Ignorable_Code_Point}\u2800\u115F\u1160\u3164\uFFA0]/u;
/** Readable as they are: layout (space, tab, line break). */
const KEPT_VISIBLE = new Set([" ", "\t", "\n"]);
/** How a long run of a layout character is named. */
const LAYOUT_RUN_NAME: Record<string, string> = {
  " ": "spaces",
  "\n": "line breaks",
  "\t": "tabs",
};
const BARE_KEY = /^[A-Za-z0-9_.-]+$/;

/** Is `char` shown as a `⟨U+XXXX⟩` marker? */
export function isEscapedChar(char: string): boolean {
  return HIDDEN.test(char) && !KEPT_VISIBLE.has(char);
}

/**
 * The marker brackets themselves. A value that typed `⟨U+200D⟩` rendered
 * exactly like the marker for a real joiner (twelfth review of #1242), so a
 * literal bracket is always marked — on its own, never folded into a run of
 * invisible characters, since it is not one. Every `⟨` on the card then opens
 * a marker the summary wrote, and no marker holds a bracket inside.
 */
const MARKER_BRACKET = new Set(["\u27E8", "\u27E9"]);

/**
 * A combining mark draws on the glyph in front of it. Where it has none to
 * draw on, it lands on whatever stands beside it: `\u05BCבא` (a dagesh in
 * front of a right-to-left word) was pixel-identical to `בא\u05BC` (the
 * dagesh on the word's last letter) in Chromium and WebKit, and `a\u05BCع` to
 * `aع\u05BC` in Chromium — a Hebrew dagesh draws on neither a Latin nor an
 * Arabic letter (thirteenth review of #1242). So a mark is kept only where it
 * sits on a letter it is written with — a letter of one of its scripts
 * (Script_Extensions: the dagesh on a Hebrew letter, U+0301 on a Latin,
 * Greek or Cyrillic one), or any letter for a mark of every script (`Zinh`:
 * U+0336, U+20E3, …) — directly or through marks that do (`ש\u05BC\u05C1`,
 * `e\u0323\u0302`). Every other mark is shown as a marker: at the start,
 * after a space, a digit, a `/`, punctuation or a marker the summary wrote,
 * and on another script's letter.
 *
 * The scripts that have marks of their own, as Node 22's engine (Unicode 17)
 * knows them; `summary.test.ts` checks that every mark not of every script
 * belongs to one. A name the engine does not know is skipped rather than
 * failing at load: an engine that old has none of that script's characters.
 */
const MARK_SCRIPTS = `Adlm Aghb Ahom Arab Armn Bali Bamu Bass Batk Beng Bhks Bopo Brah Bugi Buhd
  Cakm Cham Cher Copt Cyrl Deva Diak Dogr Dupl Egyp Elba Ethi Gara Glag Gong Gonm Goth Gran Grek
  Gujr Gukh Guru Hang Hani Hano Hebr Hira Hmng Hmnp Java Kali Kana Kawi Khar Khmr Khoj Kits Knda
  Kthi Lana Laoo Latn Lepc Limb Mahj Maka Mand Mani Marc Mend Miao Mlym Modi Mong Mtei Mymr Nagm
  Nand Newa Nkoo Onao Orya Osge Ougr Perm Plrd Rjng Rohg Samr Saur Sgnw Shrd Sidd Sind Sinh Sogd
  Soyo Sund Sunu Sylo Syrc Tagb Takr Tale Taml Tavt Tayo Telu Tfng Tglg Thaa Thai Tibt Tirh Todr
  Toto Tutg Wcho Yezi Zanb`;
const MARK_SCRIPT_CHARS = new Map(
  MARK_SCRIPTS.split(/\s+/).flatMap((name): [string, RegExp][] => {
    try {
      return [[name, new RegExp(`\\p{scx=${name}}`, "u")]];
    } catch {
      return [];
    }
  })
);
const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;
const OF_EVERY_SCRIPT = /\p{scx=Zinh}/u;
const scriptsOfMark = new Map<string, string[]>();

/** The names in MARK_SCRIPTS of the scripts `mark` is written with. */
export function markScripts(mark: string): string[] {
  let names = scriptsOfMark.get(mark);
  if (!names) {
    names = [...MARK_SCRIPT_CHARS].filter(([, chars]) => chars.test(mark)).map(([name]) => name);
    scriptsOfMark.set(mark, names);
  }
  return names;
}

/** Does `mark` draw on `letter` — is it of every script, or of one of the letter's? */
function sitsOn(mark: string, letter: string): boolean {
  return (
    OF_EVERY_SCRIPT.test(mark) ||
    markScripts(mark).some((name) => MARK_SCRIPT_CHARS.get(name)!.test(letter))
  );
}

function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * A run of hidden characters, every one of them named. Only a stretch of ONE
 * repeated character is counted (`⟨180 × U+2800⟩`); a mixed run names each
 * character in order. It used to collapse into one marker naming its first
 * three, so `a` + four joiners and `a` + three joiners and a non-joiner were
 * one card (fourteenth review of #1242): a marker that drops a character
 * drops the difference between two values.
 */
function escapeRun(run: string[]): string {
  let out = "";
  for (let i = 0; i < run.length;) {
    let length = 1;
    while (i + length < run.length && run[i + length] === run[i]) length++;
    const marker = `⟨${codePoint(run[i])}⟩`;
    out += length > MAX_ESCAPED_RUN ? `⟨${length} × ${codePoint(run[i])}⟩` : marker.repeat(length);
    i += length;
  }
  return out;
}

/** The layout characters a value may be padded with. */
const LAYOUT = new Set([" ", "\t", "\n"]);

/**
 * Walks `text` by code point. Hidden characters become markers (runs
 * collapsed). With
 * `layout`, a run of MIN_LAYOUT_RUN or more spaces, line breaks or tabs
 * becomes a count and a shorter one stays as it is; every other character goes
 * through `visible`. With `target`, a shorter run at the start or end is
 * marked as well.
 */
function escapeText(
  text: string,
  {
    layout,
    target = false,
    visible = (c) => c,
  }: { layout: boolean; target?: boolean; visible?: (char: string) => string }
): string {
  // A CRLF is one line break, as every mail client and editor shows it. Only
  // for values: a key with a CR in it is not a line break, it is a trick.
  const source = layout ? text.replace(/\r\n/g, "\n") : text;
  const chars = [...source];
  let leadEnd = 0;
  let trailStart = chars.length;
  if (target) {
    while (leadEnd < chars.length && LAYOUT.has(chars[leadEnd])) leadEnd++;
    while (trailStart > leadEnd && LAYOUT.has(chars[trailStart - 1])) trailStart--;
  }
  let out = "";
  let run: string[] = [];
  /** The letter the last character written is, or sits on as a kept mark. */
  let base: string | null = null;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const under: string | null = base;
    base = null;
    if (isEscapedChar(char)) {
      run.push(char);
      continue;
    }
    const mark = MARK.test(char);
    if (MARKER_BRACKET.has(char) || (mark && !(under && sitsOn(char, under)))) {
      if (run.length > 0) out += escapeRun(run);
      run = [];
      out += `⟨${codePoint(char)}⟩`;
      continue;
    }
    const runName = layout ? LAYOUT_RUN_NAME[char] : undefined;
    let length = 1;
    if (runName) {
      while (i + length < chars.length && chars[i + length] === char) length++;
    }
    const atEdge = i < leadEnd || i >= trailStart;
    if (atEdge && length < MIN_LAYOUT_RUN) {
      // Padding around a target: shown, never rendered as blank space.
      run.push(char);
      continue;
    }
    if (run.length > 0) {
      out += escapeRun(run);
      run = [];
    }
    if (runName) {
      out += length >= MIN_LAYOUT_RUN ? `⟨${length} ${runName}⟩` : char.repeat(length);
      // Skip the rest of the run; the loop's own step moves past its last.
      i += length - 1;
      continue;
    }
    out += visible(char);
    base = mark ? under : LETTER.test(char) ? char : null;
  }
  if (run.length > 0) out += escapeRun(run);
  return out;
}

/** A value as sent, with everything that could hide text made visible. */
export function renderText(text: string, target = false): string {
  return escapeText(text, { layout: true, target });
}

/**
 * How a key is labelled. A plain identifier is shown as it is. Anything else
 * is shown quoted, with every character outside printable ASCII escaped — a
 * trailing space, a tab, a Cyrillic "о" in "tо" — so it cannot pass for the
 * key it imitates. Quoted labels always start with `"`, which no bare label
 * can, so the two never collide.
 */
function keyLabel(key: string): string {
  if (key.length <= MAX_KEY_LEN && BARE_KEY.test(key)) return key;
  const chars = [...key];
  const shown = escapeText(chars.slice(0, MAX_KEY_LEN).join(""), {
    layout: false,
    visible: (char) => {
      const code = char.codePointAt(0)!;
      return code >= 0x20 && code <= 0x7e ? char : `⟨${codePoint(char)}⟩`;
    },
  });
  const quoted = JSON.stringify(shown);
  return chars.length > MAX_KEY_LEN
    ? `${quoted} … [key cut: ${chars.length - MAX_KEY_LEN} more characters not shown]`
    : quoted;
}

/**
 * A decoded ref, as a node of its own (`SummaryNode`): written into the text,
 * `(record reference: …)` read exactly like a plain string of those
 * characters, which pinchy-odoo resolves by NAME (fourteenth review of #1242).
 * The label is the record's display name as Odoo gave it when the ref was
 * minted — a hint for the reader, not an argument: the call acts on
 * `model #id`, which is always shown whole. So a cut label is marked, but it
 * does not make the call incomplete.
 */
function describeRef(record: RefRecord, budget: Budget): SummaryNode {
  const chars = [...renderText(record.label)];
  const node: SummaryNode = {
    "@": "ref",
    model: renderText(record.model),
    id: record.id,
    label: chars.slice(0, MAX_REF_LABEL_LEN).join(""),
    labelCut: Math.max(0, chars.length - MAX_REF_LABEL_LEN),
  };
  budget.chars -= refText(node).length;
  return node;
}

/**
 * A string with what Pinchy says about it, or the plain string when there is
 * nothing to say. The notes are charged as the prompt prints them.
 */
function noted(text: string, notes: SummaryNote[], budget: Budget): string | SummaryNode {
  if (notes.length === 0) return text;
  for (const note of notes) budget.chars -= noteText(note).length + 3;
  return { "@": "noted", text, notes };
}

/** Spends `text` against the budget, cutting it — and saying so — if needed. */
function bounded(text: string, budget: Budget): string {
  let allowed = Math.max(0, budget.chars);
  if (text.length <= allowed) {
    budget.chars -= text.length;
    return text;
  }
  exceed(budget, TOO_LARGE_IN_ALL);
  // Never between the two halves of a surrogate pair: the lone half would be
  // an invalid string, and Postgres refuses it in jsonb.
  const last = text.charCodeAt(allowed - 1);
  if (allowed > 0 && last >= 0xd800 && last <= 0xdbff) allowed--;
  budget.chars -= allowed;
  return `${text.slice(0, allowed)}${truncationMarker(text.length - allowed)}`;
}

/**
 * The punycode form of a non-ASCII host: `boss@fіrma.at` with a Cyrillic "і"
 * renders exactly like the real domain, and its ASCII form (`xn--…`) is what
 * shows that it is not. With `always`, an ASCII host is named too.
 */
function punycodeNote(host: string | null, always = false): SummaryNote | null {
  if (host === null || (!always && /^[\x00-\x7F]*$/.test(host))) return null;
  const ascii = domainToASCII(host);
  return ascii ? { kind: "host", host: ascii } : { kind: "not-a-domain" };
}

/**
 * The host a URL really reaches, as the WHATWG parser resolves it — the
 * parser the tool's own `fetch` uses. A host the text merely reads as is not
 * it: in `https://fіrma.at\@evil.com/x` the backslash is a path separator, so
 * the host is fіrma.at, where a regex reading the `@` saw evil.com (fourth
 * review of #1242). Percent-encoding, a numeric IPv4 form and a homoglyph all
 * resolve to a host that reads differently, so that host is named whenever it
 * differs from the text's. A non-special scheme keeps an opaque,
 * percent-encoded host, which is decoded to read as the domain it names.
 */
function urlNote(value: string, textHost: string, always: boolean): SummaryNote | null {
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return { kind: "not-a-url" };
  }
  if (host.includes("%")) {
    try {
      host = domainToASCII(decodeURIComponent(host)) || host;
    } catch {
      // Not decodable: show it as the parser holds it.
    }
  }
  return !always && host.toLowerCase() === textHost.toLowerCase() ? null : { kind: "host", host };
}

/**
 * Past WHOLE_MAX the card previews an address like any long text, and its
 * host sits at the end, behind "Show full text". A note was written only for
 * a host that reads differently from where it goes — an ASCII one never does,
 * so `buchhaltung.intranet.firma.at.…@evil.example` and `…@firma.at.xyz`
 * collapsed to the same card (fifteenth review of #1242). Past the bound, the
 * host is always named. `shown` is the value as rendered, what the card counts.
 */
function hidesHost(shown: string): boolean {
  return codePointLength(shown) > WHOLE_MAX;
}

/**
 * The note that names the host a value reaches, when the whole value is an
 * email address or a URL. Free text that merely contains one is left alone:
 * rewriting the middle of a mail body is not what the card is for.
 */
function hostNotes(value: string, shown: string): SummaryNote[] {
  const always = hidesHost(shown);
  const url = URL_SHAPED.exec(value);
  const note = url
    ? urlNote(value, url[1], always)
    : punycodeNote(EMAIL_SHAPED.exec(value)?.[1] ?? null, always);
  return note ? [note] : [];
}

/** Length in code points — characters as a person counts them. */
function codePointLength(text: string): number {
  let length = text.length;
  for (let i = 0; i < text.length - 1; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length--;
        i++;
      }
    }
  }
  return length;
}

/** The first `count` code points of `text`. */
function headCodePoints(text: string, count: number): string {
  let end = 0;
  for (let n = 0; n < count && end < text.length; n++) {
    const code = text.charCodeAt(end);
    const next = text.charCodeAt(end + 1);
    end += code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
  }
  return text.slice(0, end);
}

function summarizeString(
  value: string,
  budget: Budget,
  path: string,
  target: boolean
): string | SummaryNode {
  if (isCanonicalRef(value)) {
    // An opaque ref is 200+ characters of base64 that mean nothing to a reader.
    // What it points AT is what matters — which record, not just which kind:
    // two invoices of one model must not produce the same card. Only a string
    // that IS a ref — exactly the encoder's form, nothing after it — and
    // decodes is rendered as a record; anything else is shown as the text it
    // is (a mail body may well start with these characters), never guessed
    // and never hidden. The shape is checked here as well as in the resolver,
    // because a lenient decode is what let `<ref>=\n\n<text>` hide the text
    // behind the record (fifth review of #1242), and the card must not rest
    // on every resolver getting that right.
    const record = budget.refRecord?.(value);
    if (record) return describeRef(record, budget);
  }
  // Measured as SENT, not as shown: a no-break space is one character a
  // person typed, though it is shown as an eight-character marker. The
  // markers count against the total, which bounds what is stored.
  const length = codePointLength(value);
  if (length > MAX_STRING_LEN) {
    exceed(budget, { kind: "text-too-long", at: path, length, limit: MAX_STRING_LEN });
    const head = renderText(headCodePoints(value, MAX_STRING_LEN), target);
    return bounded(head, budget) + truncationMarker(length - MAX_STRING_LEN);
  }
  const shown = renderText(value, target);
  return noted(bounded(shown, budget), hostNotes(value, shown), budget);
}

/**
 * Splits an address list the way a mail library would: on commas and
 * semicolons that sit outside a quoted display name and outside `<…>`.
 */
function splitAddresses(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === "\\") {
      current += ch + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">" && angle > 0) angle--;
    if (!quoted && angle === 0 && (ch === "," || ch === ";")) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Surrounding whitespace a mail library ignores around a list entry. */
const ENTRY_PADDING = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/**
 * One recipient, address first, with the punycode form of a non-ASCII domain
 * and the display name as notes beside it: printed the other way round, a
 * long familiar display name pushed the real address out of the card's
 * preview (second review of #1242), and written into the text, `(name: "X")`
 * read like an address that merely carried those characters (fourteenth).
 */
function describeRecipient(entry: string, budget: Budget): string | SummaryNode {
  const named = /^([^<>]*)<([^<>]*)>$/.exec(entry);
  const address = named ? named[2].replace(ENTRY_PADDING, "") : entry;
  const at = address.lastIndexOf("@");
  const notes: SummaryNote[] = [];
  const shown = renderText(address);
  const host = punycodeNote(at < 0 ? null : address.slice(at + 1), hidesHost(shown));
  if (host) notes.push(host);
  let name = named ? named[1].replace(ENTRY_PADDING, "") : "";
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\([\s\S])/gu, "$1");
  }
  if (name) notes.push({ kind: "name", name: renderText(name) });
  return noted(bounded(shown, budget), notes, budget);
}

function summarizeRecipients(value: unknown, budget: Budget, path: string): unknown | undefined {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!raw || !raw.every((entry) => typeof entry === "string")) return undefined;
  const addresses = raw
    .flatMap((entry) => splitAddresses(entry as string))
    .map((entry) => entry.replace(ENTRY_PADDING, ""))
    .filter((entry) => entry.length > 0);
  if (addresses.length === 0) return summarizeString(raw.join(" "), budget, path, false);
  const shown: unknown[] = addresses
    .slice(0, MAX_ITEMS)
    .map((address) => describeRecipient(address, budget));
  if (addresses.length > MAX_ITEMS) {
    exceed(budget, {
      kind: "too-many-recipients",
      at: path,
      count: addresses.length,
      limit: MAX_ITEMS,
    });
    shown.push(`… [${addresses.length - MAX_ITEMS} more addresses not shown]`);
  }
  return shown.length === 1 ? shown[0] : shown;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A secret-like text stays hidden — it may be a real secret, and the summary
 * is stored — but setting one is an effect: an attacker-chosen `access_token`
 * written into a record must not look like any other redaction. A node of its
 * own, so no text can read as one.
 */
function describeSecret(value: string, budget: Budget): SummaryNode {
  const node: SummaryNode = { "@": "secret", length: codePointLength(value) };
  budget.chars -= secretText(node).length;
  return node;
}

/** Where a value sits, for the refusal: `values.comment`, `lines[1].note`. */
function childPath(path: string, label: string): string {
  return path ? `${path}.${label}` : label;
}

function summarizeValue(
  value: unknown,
  depth: number,
  budget: Budget,
  path: string,
  secret: boolean,
  target: boolean
): unknown {
  if (typeof value === "string") {
    if (secret) return describeSecret(value, budget);
    return summarizeString(value, budget, path, target);
  }
  if (value === null || ["number", "boolean"].includes(typeof value)) {
    // A number is shown too, and 200×200×50 of them made a 5.7 MB summary
    // when they cost nothing (fourth review of #1242).
    budget.chars -= String(JSON.stringify(value)).length;
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      exceed(budget, { kind: "nested-too-deep", at: path, limit: MAX_DEPTH });
      return `… [${plural(value.length, "item")} not shown: nested too deep]`;
    }
    budget.chars -= 2;
    const shown: unknown[] = [];
    for (const item of value.slice(0, MAX_ITEMS)) {
      if (budget.chars <= 0) {
        exceed(budget, TOO_LARGE_IN_ALL);
        shown.push(`… [${value.length - shown.length} more items not shown: size limit reached]`);
        return shown;
      }
      shown.push(
        summarizeValue(item, depth + 1, budget, `${path}[${shown.length}]`, secret, target)
      );
    }
    if (value.length > MAX_ITEMS) {
      exceed(budget, { kind: "too-many-items", at: path, count: value.length, limit: MAX_ITEMS });
      shown.push(`… [${value.length - MAX_ITEMS} more items not shown]`);
    }
    return shown;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= MAX_DEPTH) {
      exceed(budget, { kind: "nested-too-deep", at: path, limit: MAX_DEPTH });
      return `… [${plural(entries.length, "field")} not shown: nested too deep]`;
    }
    budget.chars -= 2;
    return summarizeObject(entries, depth, budget, path, secret, target);
  }
  return String(value);
}

function summarizeObject(
  entries: [string, unknown][],
  depth: number,
  budget: Budget,
  path: string,
  secret: boolean,
  target: boolean
): Record<string, unknown> {
  // Who a message reaches, and where an action lands, is rendered first,
  // while the budget is whole.
  const ordered = [
    ...entries.filter(([key]) => FULL_VIEW_KEYS.has(key)),
    ...entries.filter(([key]) => !FULL_VIEW_KEYS.has(key)),
  ];
  const shown: [string, unknown][] = [];
  const used = new Set<string>();
  const add = (label: string, value: unknown) => {
    // Labels are unique by construction except where a key was cut; numbering
    // them keeps even those apart, so no row can ever overwrite another in
    // `fromEntries` below.
    let unique = label;
    for (let n = 2; used.has(unique); n++) unique = `${label} (#${n})`;
    used.add(unique);
    shown.push([unique, value]);
  };

  for (let i = 0; i < ordered.length; i++) {
    const [key, value] = ordered[i];
    const priority = FULL_VIEW_KEYS.has(key);
    if (i >= MAX_KEYS) {
      exceed(budget, {
        kind: "too-many-fields",
        at: path,
        count: ordered.length,
        limit: MAX_KEYS,
      });
      add("…", `${ordered.length - i} more fields not shown`);
      break;
    }
    if (!priority && budget.chars <= 0) {
      exceed(budget, TOO_LARGE_IN_ALL);
      add("…", `${ordered.length - i} more fields not shown: size limit reached`);
      break;
    }
    // Keys are displayed too, so they count against the same budget.
    const keyLength = codePointLength(key);
    if (keyLength > MAX_KEY_LEN) {
      exceed(budget, { kind: "key-too-long", at: path, length: keyLength, limit: MAX_KEY_LEN });
    }
    const label = keyLabel(key);
    budget.chars -= label.length;
    const at = childPath(path, label);
    // A record id is never a secret, whatever its key says; anything else
    // under a secret-like key has its texts hidden, at any depth.
    const hidden = !RECORD_ID_KEY.test(key) && (secret || SECRET_KEY.test(key));
    const recipients =
      !hidden && RECIPIENT_KEY.test(key) ? summarizeRecipients(value, budget, at) : undefined;
    add(
      label,
      recipients !== undefined
        ? recipients
        : summarizeValue(value, depth + 1, budget, at, hidden, target || TARGET_KEYS.has(key))
    );
  }
  // fromEntries defines own properties, so a "__proto__" key stays data.
  return Object.fromEntries(shown);
}

/**
 * The summary the card stores, and whether it holds the whole call. The gate
 * refuses an `incomplete` call rather than open a confirmation for it.
 */
export function summarizeCall(params: unknown, options: SummarizeOptions = {}): CallSummary {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { summary: {}, incomplete: false, exceeded: null };
  }
  const budget: Budget = {
    chars: MAX_TOTAL_CHARS,
    refRecord: options.refRecord,
    exceeded: null,
  };
  const summary = summarizeObject(
    Object.entries(params as Record<string, unknown>),
    0,
    budget,
    "",
    false,
    false
  );
  // A last value can overshoot without anything after it to cut.
  if (budget.chars < 0) exceed(budget, TOO_LARGE_IN_ALL);
  return { summary, incomplete: budget.exceeded !== null, exceeded: budget.exceeded };
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * The reason the gate gives the agent for refusing a call it cannot show in
 * full. Read by the MODEL, which relays it to the person — so it names what
 * was too large, and suggests splitting only where that can help: a list or
 * a record can be sent in parts, one file or one mail body cannot (fourth
 * review of #1242).
 */
export function describeRefusal(limit: SummaryLimit): string {
  const notRun = "so it was not run and no confirmation was opened.";
  const split = (how: string) =>
    `This call is too large to show for approval in full, ${notRun} ` +
    `${how} Split it into smaller calls and try again with each part.`;
  const stop =
    "Tell the person that, then stop — do not call this tool again with the same arguments.";
  switch (limit.kind) {
    case "text-too-long":
      return (
        `The value of ${limit.at} is ${count(limit.length)} characters long — too long to show ` +
        `for approval: a confirmation shows at most ${count(limit.limit)} characters of one ` +
        `text, ${notRun} ${stop}`
      );
    case "key-too-long":
      return (
        `A field name in ${limit.at || "the call"} is ${count(limit.length)} characters long — ` +
        `too long to show for approval (at most ${count(limit.limit)}), ${notRun} ${stop}`
      );
    case "nested-too-deep":
      return (
        `${limit.at} is nested more than ${limit.limit} levels deep — too deep to show for ` +
        `approval, ${notRun} ${stop}`
      );
    case "too-many-fields":
      return split(
        `${limit.at || "The call"} has ${count(limit.count)} fields; a confirmation shows at ` +
          `most ${limit.limit} per object — write fewer fields per call.`
      );
    case "too-many-items":
      return split(
        `${limit.at} has ${count(limit.count)} entries; a confirmation shows at most ` +
          `${limit.limit} per list — send fewer records or lines per call.`
      );
    case "too-many-recipients":
      return split(
        `${limit.at} names ${count(limit.count)} addresses; a confirmation shows at most ` +
          `${limit.limit} — send to fewer recipients per message.`
      );
    case "too-large-in-all":
      return split(
        `Shown for approval it would be more than ${count(limit.limit)} characters in all — ` +
          `send fewer fields, records or lines per call, or shorter texts.`
      );
  }
}

export function summarizeArgs(
  params: unknown,
  options: SummarizeOptions = {}
): Record<string, unknown> {
  return summarizeCall(params, options).summary;
}

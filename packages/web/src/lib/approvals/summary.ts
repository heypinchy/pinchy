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
 * So this summary keeps the structure and the content, and only ever loses
 * data in a way that SAYS so:
 *
 * - Strings are kept as sent — never trimmed or whitespace-collapsed, since a
 *   rewritten value is not the value that runs. The card renders them with
 *   `white-space: pre-wrap`. What could hide text is made visible instead:
 *   every character that renders as nothing or as blank space without being a
 *   plain space, tab or line break — controls, format characters (`Cf`: bidi
 *   overrides, zero-width, Unicode tag characters), every other space
 *   separator (no-break, ideographic, …), variation selectors and the other
 *   default-ignorables (Hangul fillers), and the braille blank U+2800 — is
 *   shown as a `⟨U+XXXX⟩` marker. A long run of them collapses into one
 *   bounded marker that says how many there were. A run of four or more
 *   spaces, line breaks or tabs is shown as `⟨N spaces⟩` / `⟨N line breaks⟩` /
 *   `⟨N tabs⟩`, so padding cannot push text out of view. Only U+200D (the emoji
 *   joiner) and U+FE0E / U+FE0F (text / emoji presentation) are left alone:
 *   they carry no payload and sit inside ordinary emoji. Strings are kept whole
 *   up to MAX_STRING_LEN; the card shows a preview and the full text on demand.
 * - Keys are never merged. A key that is not a plain identifier is shown
 *   quoted and escaped, so `"to "` (trailing space) is its own row next to
 *   `to` — trimming it into `to` once let a second, look-alike key overwrite
 *   the row the tool actually reads. Labels are unique by construction.
 * - Arrays and objects keep their actual contents, to a bounded depth, width
 *   and total size. Anything cut off is replaced by an explicit "… not shown"
 *   marker, so a reader can tell that something was left out.
 * - Recipients (`to` / `cc` / `bcc`) are split into an explicit address list,
 *   one entry each, so a comma-smuggled extra address is a visible line. Each
 *   entry names the address FIRST and the display name after it, so a long
 *   familiar name cannot push the real address out of view, and a non-ASCII
 *   domain is shown in punycode too, so a homoglyph domain reads as the
 *   different domain it is. Recipient and target keys (`FULL_VIEW_KEYS`) are
 *   rendered before anything else, so no filler in front of them can starve
 *   them of the size budget or push them past MAX_KEYS.
 * - An opaque record reference names the record it points at — model, id and
 *   label — when it decodes. A string that does not decode is shown as the
 *   text it is: free text that merely starts with the ref prefix is still free
 *   text, and hiding it would hide an email body.
 *
 * Secret-looking keys keep their value hidden at any depth, so a leaked
 * summary never exposes a token — but the row says that a secret-like field is
 * being SET, and how long the value is, because an attacker-chosen token
 * written into a record is an effect the approver has to see. The recipient
 * and subject of an email ARE kept — hiding them would defeat the point of an
 * informed confirmation.
 */
import { domainToASCII } from "node:url";
import type { RefRecord } from "./call-models";
import { FULL_VIEW_KEYS, truncationMarker } from "./display";

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
const RECIPIENT_KEY = /^(to|cc|bcc)$/i;

/** Longest string stored whole. Beyond it the value is cut and marked. */
const MAX_STRING_LEN = 4000;
const MAX_KEYS = 25;
const MAX_ITEMS = 50;
/** Deep enough for an Odoo invoice: values → invoice_line_ids → [0, 0, {…}] →
 * tax_ids → [6, 0, [ids]] sits at depth 7. MAX_TOTAL_CHARS bounds the size. */
const MAX_DEPTH = 10;
/** Total characters across all strings and keys in one summary — keeps the
 * jsonb row (and the poll response that carries every pending card) bounded. */
const MAX_TOTAL_CHARS = 16_000;
/** Longest key (in code points) rendered; a longer one is cut and says so. */
const MAX_KEY_LEN = 100;
/** Longest record label rendered for a reference. */
const MAX_REF_LABEL_LEN = 200;
/** A run of invisible characters longer than this collapses into one marker. */
const MAX_ESCAPED_RUN = 3;
/** A run of this many spaces, line breaks or tabs is shown as a count. */
const MIN_LAYOUT_RUN = 4;

/** pinchy-odoo's opaque record handle. See `call-models.ts`. */
const REF_PREFIX = "pinchy_ref:v1:";

export interface SummarizeOptions {
  /** Resolves an opaque record reference to the record it points at. */
  refRecord?: (ref: string) => RefRecord | null;
}

interface Budget {
  chars: number;
  refRecord?: (ref: string) => RefRecord | null;
}

/**
 * Renders as nothing or as blank space: controls, every format character
 * (bidi, zero-width, tags, U+FFF9–FFFB, …), every space separator, line and
 * paragraph separators, every default-ignorable code point (variation
 * selectors, Hangul fillers, the combining grapheme joiner, …) and the
 * braille blank. The same set the write tools refuse (`hidden-chars.ts` in
 * pinchy-email / pinchy-files; `hidden-chars-drift.test.ts` pins the two).
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}\u2800\u115F\u1160\u3164\uFFA0]/u;
/** Readable as they are: layout (space, tab, line break), and the three that
 * cannot carry a payload and appear in ordinary emoji: 👨‍👩‍👧, ❤️. */
const KEPT_VISIBLE = new Set([" ", "\t", "\n", "\u200D", "\uFE0E", "\uFE0F"]);
/** How a long run of a layout character is named. */
const LAYOUT_RUN_NAME: Record<string, string> = {
  " ": "spaces",
  "\n": "line breaks",
  "\t": "tabs",
};
const BARE_KEY = /^[A-Za-z0-9_.-]+$/;

/** Is `char` shown as a `⟨U+XXXX⟩` marker rather than rendered? */
export function isEscapedChar(char: string): boolean {
  return HIDDEN.test(char) && !KEPT_VISIBLE.has(char);
}

function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

function escapeRun(run: string[]): string {
  if (run.length <= MAX_ESCAPED_RUN) return run.map((char) => `⟨${codePoint(char)}⟩`).join("");
  const preview = run.slice(0, MAX_ESCAPED_RUN).map(codePoint).join(" ");
  return `⟨${run.length} invisible characters: ${preview} …⟩`;
}

/**
 * Walks `text` by code point. Hidden characters become markers (runs
 * collapsed). With `layout`, a run of MIN_LAYOUT_RUN or more spaces, line
 * breaks or tabs becomes a count and a shorter one stays as it is; every other
 * character goes through `visible`.
 */
function escapeText(
  text: string,
  { layout, visible = (c) => c }: { layout: boolean; visible?: (char: string) => string }
): string {
  const chars = [...text];
  let out = "";
  let run: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (isEscapedChar(char)) {
      run.push(char);
      continue;
    }
    if (run.length > 0) {
      out += escapeRun(run);
      run = [];
    }
    const runName = layout ? LAYOUT_RUN_NAME[char] : undefined;
    if (runName) {
      let end = i;
      while (end + 1 < chars.length && chars[end + 1] === char) end++;
      const length = end - i + 1;
      out += length >= MIN_LAYOUT_RUN ? `⟨${length} ${runName}⟩` : char.repeat(length);
      i = end;
      continue;
    }
    out += visible(char);
  }
  if (run.length > 0) out += escapeRun(run);
  return out;
}

/** A value as sent, with everything that could hide text made visible. */
function renderText(text: string): string {
  return escapeText(text, { layout: true });
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

function describeRef(record: RefRecord): string {
  const label = renderText(record.label);
  const chars = [...label];
  const cut =
    chars.length > MAX_REF_LABEL_LEN
      ? ` … [label cut: ${chars.length - MAX_REF_LABEL_LEN} more characters not shown]`
      : "";
  const shown = JSON.stringify(chars.slice(0, MAX_REF_LABEL_LEN).join(""));
  return `(record reference: ${renderText(record.model)} #${record.id} ${shown}${cut})`;
}

/** Spends `text` against the budget, cutting it — and saying so — if needed. */
function bounded(text: string, budget: Budget): string {
  const allowed = Math.max(0, Math.min(MAX_STRING_LEN, budget.chars));
  if (text.length <= allowed) {
    budget.chars -= text.length;
    return text;
  }
  budget.chars -= allowed;
  return `${text.slice(0, allowed)}${truncationMarker(text.length - allowed)}`;
}

function summarizeString(value: string, budget: Budget): string {
  if (value.startsWith(REF_PREFIX)) {
    // An opaque ref is 200+ characters of base64 that mean nothing to a reader.
    // What it points AT is what matters — which record, not just which kind:
    // two invoices of one model must not produce the same card. Only a string
    // that DECODES is rendered as a record; anything else is shown as the text
    // it is (a mail body may well start with these characters), never guessed
    // and never hidden.
    const record = budget.refRecord?.(value);
    if (record) {
      const text = describeRef(record);
      budget.chars -= text.length;
      return text;
    }
  }
  return bounded(renderText(value), budget);
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
 * The address, with the punycode form of a non-ASCII domain appended:
 * `boss@fіrma.at` with a Cyrillic "і" renders exactly like the real domain,
 * and its ASCII form (`xn--…`) is what shows that it is not.
 */
function describeAddress(address: string): string {
  const shown = renderText(address);
  const at = address.lastIndexOf("@");
  if (at < 0) return shown;
  const domain = address.slice(at + 1);
  if (/^[\x00-\x7F]*$/.test(domain)) return shown;
  const ascii = domainToASCII(domain);
  return `${shown} (${ascii || "not a valid domain name"})`;
}

/**
 * One recipient, address first: `attacker@evil.com (name: "Raimund Korber")`.
 * Printed the other way round, a long familiar display name pushed the real
 * address out of the card's preview (second review of #1242).
 */
function describeRecipient(entry: string): string {
  const named = /^([^<>]*)<([^<>]*)>$/.exec(entry);
  if (!named) return describeAddress(entry);
  const address = describeAddress(named[2].replace(ENTRY_PADDING, ""));
  let name = named[1].replace(ENTRY_PADDING, "");
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\([\s\S])/gu, "$1");
  }
  return name ? `${address} (name: ${JSON.stringify(renderText(name))})` : address;
}

function summarizeRecipients(value: unknown, budget: Budget): unknown | undefined {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!raw || !raw.every((entry) => typeof entry === "string")) return undefined;
  const addresses = raw
    .flatMap((entry) => splitAddresses(entry as string))
    .map((entry) => entry.replace(ENTRY_PADDING, ""))
    .filter((entry) => entry.length > 0);
  if (addresses.length === 0) return summarizeString(raw.join(" "), budget);
  const shown = addresses
    .slice(0, MAX_ITEMS)
    .map((address) => bounded(describeRecipient(address), budget));
  if (addresses.length > MAX_ITEMS) {
    shown.push(`… [${addresses.length - MAX_ITEMS} more addresses not shown]`);
  }
  return shown.length === 1 ? shown[0] : shown;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A secret-like value stays hidden — it may be a real secret, and the summary
 * is stored — but setting one is an effect: an attacker-chosen `access_token`
 * written into a record must not look like any other redaction.
 */
function describeSecret(value: unknown): string {
  const what =
    typeof value === "string"
      ? plural([...value].length, "character")
      : value === null
        ? "null"
        : Array.isArray(value)
          ? "a list"
          : typeof value === "object"
            ? "an object"
            : `a ${typeof value}`;
  return `[secret-like field is being set — value hidden, ${what}]`;
}

function summarizeValue(value: unknown, depth: number, budget: Budget): unknown {
  if (typeof value === "string") return summarizeString(value, budget);
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `… [${plural(value.length, "item")} not shown: nested too deep]`;
    const shown: unknown[] = [];
    for (const item of value.slice(0, MAX_ITEMS)) {
      if (budget.chars <= 0) {
        shown.push(`… [${value.length - shown.length} more items not shown: size limit reached]`);
        return shown;
      }
      shown.push(summarizeValue(item, depth + 1, budget));
    }
    if (value.length > MAX_ITEMS) {
      shown.push(`… [${value.length - MAX_ITEMS} more items not shown]`);
    }
    return shown;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= MAX_DEPTH)
      return `… [${plural(entries.length, "field")} not shown: nested too deep]`;
    return summarizeObject(entries, depth, budget);
  }
  return String(value);
}

function summarizeObject(
  entries: [string, unknown][],
  depth: number,
  budget: Budget
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
    // Labels are unique by construction except where a key was cut or a run
    // collapsed; numbering them keeps even those apart, so no row can ever
    // overwrite another in `fromEntries` below.
    let unique = label;
    for (let n = 2; used.has(unique); n++) unique = `${label} (#${n})`;
    used.add(unique);
    shown.push([unique, value]);
  };

  for (let i = 0; i < ordered.length; i++) {
    const [key, value] = ordered[i];
    const priority = FULL_VIEW_KEYS.has(key);
    if (i >= MAX_KEYS) {
      add("…", `${ordered.length - i} more fields not shown`);
      break;
    }
    if (!priority && budget.chars <= 0) {
      add("…", `${ordered.length - i} more fields not shown: size limit reached`);
      break;
    }
    // Keys are displayed too, so they count against the same budget.
    const label = keyLabel(key);
    budget.chars -= label.length;
    if (SECRET_KEY.test(key)) {
      add(label, describeSecret(value));
      continue;
    }
    const recipients = RECIPIENT_KEY.test(key) ? summarizeRecipients(value, budget) : undefined;
    add(label, recipients !== undefined ? recipients : summarizeValue(value, depth + 1, budget));
  }
  // fromEntries defines own properties, so a "__proto__" key stays data.
  return Object.fromEntries(shown);
}

export function summarizeArgs(
  params: unknown,
  options: SummarizeOptions = {}
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  return summarizeObject(Object.entries(params as Record<string, unknown>), 0, {
    chars: MAX_TOTAL_CHARS,
    refRecord: options.refRecord,
  });
}

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
 * - Strings are whitespace-normalised (a run of spaces cannot push text out of
 *   view) and every invisible character — controls, format characters (`Cf`:
 *   bidi overrides, zero-width, Unicode tag characters), variation selectors
 *   and the other default-ignorables — is shown as a `⟨U+XXXX⟩` marker instead
 *   of rendered. A long run of them collapses into one bounded marker that
 *   says how many there were, so a payload smuggled in tag characters is
 *   obvious without flooding the card. Only U+200D (the emoji joiner) and
 *   U+FE0E / U+FE0F (text / emoji presentation) are left alone: they carry no
 *   payload and sit inside ordinary emoji. Strings are kept whole up to
 *   MAX_STRING_LEN; the card shows a preview and the full text on demand.
 * - Keys are never merged. A key that is not a plain identifier is shown
 *   quoted and escaped, so `"to "` (trailing space) is its own row next to
 *   `to` — trimming it into `to` once let a second, look-alike key overwrite
 *   the row the tool actually reads. Labels are unique by construction.
 * - Arrays and objects keep their actual contents, to a bounded depth, width
 *   and total size. Anything cut off is replaced by an explicit "… not shown"
 *   marker, so a reader can tell that something was left out.
 * - Recipients (`to` / `cc` / `bcc`) are split into an explicit address list,
 *   one entry each, so a comma-smuggled extra address is a visible line, and a
 *   non-ASCII domain is shown in punycode too, so a homoglyph domain reads as
 *   the different domain it is. Recipient-like keys are rendered before
 *   anything else, so no filler in front of them can starve them of the size
 *   budget or push them past MAX_KEYS.
 * - Opaque record references name the record they point at — model, id and
 *   label — when they decode, and say only "(record reference)" when not.
 *
 * Secret-looking keys are redacted at any depth, so a leaked summary never
 * exposes a token. The recipient and subject of an email ARE kept — hiding
 * them would defeat the point of an informed confirmation.
 */
import { domainToASCII } from "node:url";
import type { RefRecord } from "./call-models";

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
const RECIPIENT_KEY = /^(to|cc|bcc)$/i;
/**
 * Keys that name who a message reaches. Exact spellings, so the set stays
 * small: a case-insensitive match would let 1,024 spellings of "recipients"
 * crowd out the real `to`.
 */
const PRIORITY_KEYS = new Set([
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
 * Invisible or able to change what is displayed without being displayed:
 * controls, every format character (bidi, zero-width, tags, U+FFF9–FFFB, …)
 * and every default-ignorable code point (variation selectors, Hangul fillers,
 * the combining grapheme joiner, …).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/** Cannot carry a payload, and appear in ordinary emoji: 👨‍👩‍👧, ❤️. */
const KEPT_VISIBLE = new Set(["\u200D", "\uFE0E", "\uFE0F"]);
/** Whitespace, except U+FEFF — a zero-width no-break space is invisible, not a
 * space, so it is escaped rather than collapsed. */
const WHITESPACE_RUN = /[^\S\uFEFF]+/gu;
const BARE_KEY = /^[A-Za-z0-9_.-]+$/;

function isInvisible(char: string): boolean {
  return INVISIBLE.test(char) && !KEPT_VISIBLE.has(char);
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
 * Walks `text` by code point. Invisible characters become markers (runs
 * collapsed); every other character goes through `visible`.
 */
function escapeInvisible(text: string, visible: (char: string) => string = (c) => c): string {
  let out = "";
  let run: string[] = [];
  for (const char of text) {
    if (isInvisible(char)) {
      run.push(char);
      continue;
    }
    if (run.length > 0) {
      out += escapeRun(run);
      run = [];
    }
    out += visible(char);
  }
  if (run.length > 0) out += escapeRun(run);
  return out;
}

/** Collapse whitespace runs and make invisible characters visible. */
function normalizeText(text: string): string {
  return escapeInvisible(text.replace(WHITESPACE_RUN, " ")).trim();
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
  const shown = escapeInvisible(chars.slice(0, MAX_KEY_LEN).join(""), (char) => {
    const code = char.codePointAt(0)!;
    return code >= 0x20 && code <= 0x7e ? char : `⟨${codePoint(char)}⟩`;
  });
  const quoted = JSON.stringify(shown);
  return chars.length > MAX_KEY_LEN
    ? `${quoted} … [key cut: ${chars.length - MAX_KEY_LEN} more characters not shown]`
    : quoted;
}

function describeRef(record: RefRecord): string {
  const label = normalizeText(record.label);
  const chars = [...label];
  const cut =
    chars.length > MAX_REF_LABEL_LEN
      ? ` … [label cut: ${chars.length - MAX_REF_LABEL_LEN} more characters not shown]`
      : "";
  const shown = JSON.stringify(chars.slice(0, MAX_REF_LABEL_LEN).join(""));
  return `(record reference: ${normalizeText(record.model)} #${record.id} ${shown}${cut})`;
}

function summarizeString(value: string, budget: Budget): string {
  if (value.startsWith(REF_PREFIX)) {
    // An opaque ref is 200+ characters of base64 that mean nothing to a reader.
    // What it points AT is what matters — which record, not just which kind:
    // two invoices of one model must not produce the same card. A ref that
    // does not decode is named as nothing more than a ref; never guessed.
    const record = budget.refRecord?.(value);
    if (!record) return "(record reference)";
    const text = describeRef(record);
    budget.chars -= text.length;
    return text;
  }
  const text = normalizeText(value);
  const allowed = Math.max(0, Math.min(MAX_STRING_LEN, budget.chars));
  if (text.length <= allowed) {
    budget.chars -= text.length;
    return text;
  }
  budget.chars -= allowed;
  return `${text.slice(0, allowed)}… [truncated: ${text.length - allowed} more characters not shown]`;
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

/**
 * Appends the punycode form of a non-ASCII domain: `boss@fіrma.at` with a
 * Cyrillic "і" renders exactly like the real domain, and its ASCII form
 * (`xn--…`) is what shows that it is not.
 */
function withAsciiDomain(address: string): string {
  const angled = /<([^<>]*)>$/.exec(address);
  const bare = angled ? angled[1] : address;
  const at = bare.lastIndexOf("@");
  if (at < 0) return address;
  const domain = bare.slice(at + 1);
  if (/^[\x00-\x7F]*$/.test(domain)) return address;
  const ascii = domainToASCII(domain);
  return `${address} (${ascii || "not a valid domain name"})`;
}

function summarizeRecipients(value: unknown, budget: Budget): unknown | undefined {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!raw || !raw.every((entry) => typeof entry === "string")) return undefined;
  const addresses = raw
    .flatMap((entry) => splitAddresses(entry as string))
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0);
  if (addresses.length === 0) return summarizeString(raw.join(" "), budget);
  const shown = addresses
    .slice(0, MAX_ITEMS)
    .map((address) => summarizeString(withAsciiDomain(address), budget));
  if (addresses.length > MAX_ITEMS) {
    shown.push(`… [${addresses.length - MAX_ITEMS} more addresses not shown]`);
  }
  return shown.length === 1 ? shown[0] : shown;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
  // Who a message reaches is rendered first, while the budget is whole.
  const ordered = [
    ...entries.filter(([key]) => PRIORITY_KEYS.has(key)),
    ...entries.filter(([key]) => !PRIORITY_KEYS.has(key)),
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
    const priority = PRIORITY_KEYS.has(key);
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
      add(label, "[redacted]");
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

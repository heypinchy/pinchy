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
 *   view) and bidi / zero-width / control characters are made visible rather
 *   than rendered. They are kept whole up to MAX_STRING_LEN; the card shows a
 *   preview and the full text on demand.
 * - Arrays and objects keep their actual contents, to a bounded depth, width
 *   and total size. Anything cut off is replaced by an explicit "… not shown"
 *   marker, so a reader can tell that something was left out.
 * - Recipients (`to` / `cc` / `bcc`) are split into an explicit address list,
 *   one entry each, so a comma-smuggled extra address is a visible line.
 *
 * Secret-looking keys are redacted at any depth, so a leaked summary never
 * exposes a token. The recipient and subject of an email ARE kept — hiding
 * them would defeat the point of an informed confirmation.
 */
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
const RECIPIENT_KEY = /^(to|cc|bcc)$/i;

/** Longest string stored whole. Beyond it the value is cut and marked. */
const MAX_STRING_LEN = 4000;
const MAX_KEYS = 25;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;
/** Total characters across all strings in one summary — keeps the jsonb row
 * (and the poll response that carries every pending card) bounded. */
const MAX_TOTAL_CHARS = 16_000;

/** pinchy-odoo's opaque record handle. See `call-models.ts`. */
const REF_PREFIX = "pinchy_ref:v1:";

export interface SummarizeOptions {
  /** Resolves an opaque record reference to the model it points at. */
  refModel?: (ref: string) => string | null;
}

interface Budget {
  chars: number;
  refModel?: (ref: string) => string | null;
}

/** Zero-width, bidi-control and soft-hyphen characters: invisible or able to
 * reorder what is displayed. (U+200D, the emoji joiner, is left alone.) */
const INVISIBLE =
  /[\p{Cc}\u00AD\u061C\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]/gu;

function visibleEscape(char: string): string {
  return `⟨U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`;
}

/** Collapse whitespace runs and make invisible characters visible. */
function normalizeText(text: string): string {
  return text
    .replace(/[\s᠎]+/gu, " ")
    .replace(INVISIBLE, visibleEscape)
    .trim();
}

function summarizeString(value: string, budget: Budget): string {
  if (value.startsWith(REF_PREFIX)) {
    // An opaque ref is 200+ characters of base64 that mean nothing to a reader.
    // What it points AT is what matters, so name the model when it decodes.
    const model = budget.refModel?.(value);
    return model ? `(record reference: ${model})` : "(record reference)";
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

function summarizeRecipients(value: unknown, budget: Budget): unknown | undefined {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!raw || !raw.every((entry) => typeof entry === "string")) return undefined;
  const addresses = raw
    .flatMap((entry) => splitAddresses(entry as string))
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0);
  if (addresses.length === 0) return summarizeString(raw.join(" "), budget);
  const shown = addresses.slice(0, MAX_ITEMS).map((address) => summarizeString(address, budget));
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
    const shown = value.slice(0, MAX_ITEMS).map((item) => summarizeValue(item, depth + 1, budget));
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
  const shown: [string, unknown][] = entries.slice(0, MAX_KEYS).map(([key, value]) => {
    // Keys are displayed too, so they get the same treatment as values.
    const label = normalizeText(key.slice(0, 200));
    if (SECRET_KEY.test(key)) return [label, "[redacted]"];
    const recipients = RECIPIENT_KEY.test(key) ? summarizeRecipients(value, budget) : undefined;
    return [
      label,
      recipients !== undefined ? recipients : summarizeValue(value, depth + 1, budget),
    ];
  });
  if (entries.length > MAX_KEYS) {
    shown.push(["…", `${entries.length - MAX_KEYS} more fields not shown`]);
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
    refModel: options.refModel,
  });
}

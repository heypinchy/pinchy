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

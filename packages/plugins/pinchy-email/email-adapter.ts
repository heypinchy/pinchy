export type Folder = "INBOX" | "SENT" | "DRAFTS" | "TRASH" | "SPAM";

// Tracks which mock-override env vars we've already warned about in this
// process, so a leftover override doesn't spam the log on every tool call.
const warnedMockOverrides = new Set<string>();

// Returns `overrideVar`'s value, but ONLY when `flagVar` is explicitly "1".
// Shared by the Gmail and Graph adapters, which both accept a *_API_BASE_URL
// override so E2E tests can redirect API calls to a local mock server.
// Without the paired flag, the override is ignored (the caller falls back to
// the real API host) and a one-time warning is logged — mirroring the
// IMAP/SMTP mock seam in imap-adapter.ts, which requires the same
// PINCHY_INSECURE_MAIL_MOCK flag for the same reason: a *_API_BASE_URL
// carried into production by accident must not silently redirect
// OAuth-authenticated API calls (and the bearer token sent with them) to
// whatever host it names.
export function resolveInsecureMockBaseUrl(
  overrideVar: string,
  flagVar: string
): string | undefined {
  const override = process.env[overrideVar];
  if (!override) return undefined;
  if (process.env[flagVar] === "1") return override;
  if (!warnedMockOverrides.has(overrideVar)) {
    warnedMockOverrides.add(overrideVar);
    console.warn(
      `[pinchy-email] ${overrideVar} is set but ${flagVar} is not "1" — ignoring it and using the ` +
        `real API host. If this is a test/mock stack, also set ${flagVar}=1.`
    );
  }
  return undefined;
}

// Test-only: clears the warn-once dedupe so a test can assert the warning
// fires again after resetting env stubs.
export function resetInsecureMockWarningsForTest(): void {
  warnedMockOverrides.clear();
}

// Escape a value for embedding inside a double-quoted query string: backslashes
// BEFORE quotes so a trailing "\" can't escape the closing quote. Used by both
// the Gmail query builder and the Graph $search KQL builder; each adapter keeps
// its own wrapping/quoting policy on top of this.
export function escapeDoubleQuoted(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Block-level tags mark a line break in the rendered message. Collapsing them
// to a space along with everything else turns a whole email into one endless
// line, which is exactly what the model then has to reason over.
const HTML_BLOCK_BOUNDARY_RE =
  /<\/?(?:p|div|br|tr|li|ul|ol|h[1-6]|table|thead|tbody|blockquote|section|article|pre|hr)\b[^>]*>/gi;

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

// Reduce an HTML body to readable plain text.
//
// This is a *fallback* for IMAP — mailparser's bundled html-to-text already
// derives `ParsedMail.text` from the html in the common case, so IMAP only
// reaches this when a message genuinely has no text/plain part. For Graph it
// is the *primary* path (Graph hands back `body.content` verbatim in whatever
// `body.contentType` the message was stored in, and most Outlook mail is
// stored as html), and it is the html-only path for Gmail. So "good enough
// for a rare fallback" is not the bar any more: block-level tags become line
// breaks so paragraph and list structure survives, and the handful of
// entities that actually appear in mail bodies are decoded.
//
// Still deliberately dependency-free. A real HTML parser buys correctness on
// markup this never sees — the output is read by a model, not rendered.
export function stripHtml(html: string): string {
  return (
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      // Outlook's conditional comments (`<!--[if mso]> … <![endif]-->`) are
      // markup, not content; without this their bodies survive tag-stripping
      // and read as duplicated text.
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(HTML_BLOCK_BOUNDARY_RE, "\n")
      .replace(/<[^>]+>/g, " ")
      // Decoded AFTER tag removal, so a `&lt;script&gt;` in the source can
      // never become a tag this function then fails to strip.
      .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (m, name: string) => {
        return HTML_ENTITIES[name.toLowerCase()] ?? m;
      })
      // Horizontal whitespace only — `\s+` would eat the line breaks above.
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Ceiling for an email body handed to the model, in characters.
 *
 * OpenClaw's runtime caps every tool result at 64000 chars and replaces the
 * overflow with a literal truncation marker spliced MID-JSON, so the model
 * receives corrupt JSON and loops on it — the production failure documented on
 * `ODOO_READ_RESULT_BUDGET_CHARS` in pinchy-odoo/index.ts. An email body is
 * the one unbounded field in `email_read`'s payload: a real HTML marketing
 * mail runs to hundreds of KB, and even stripped to text a newsletter clears
 * 64000 easily. Bounding well under the cap keeps our JSON intact and leaves
 * room for several reads inside OpenClaw's 256000-char aggregate budget.
 */
export const EMAIL_BODY_MAX_CHARS = 30000;

/**
 * Bound a body to {@link EMAIL_BODY_MAX_CHARS}. A body that already fits is
 * returned unchanged (same string, no marker). An oversized one keeps its
 * leading `EMAIL_BODY_MAX_CHARS` characters and says so in words the model can
 * act on — a bare `[truncated]` reads as part of the message and leaves the
 * model free to report the cut text as the whole email.
 */
export function truncateEmailBody(body: string, max: number = EMAIL_BODY_MAX_CHARS): string {
  if (body.length <= max) return body;
  return (
    `${body.slice(0, max)}\n\n[Body truncated: this is the first ${max} of ${body.length} ` +
    `characters. The rest was not read — say the message is longer rather than ` +
    `treating this as its full text.]`
  );
}

// Shared by every adapter: the canonical-name validation and error message are
// identical across providers, only the provider-specific value for each
// folder differs (Gmail label IDs vs Graph well-known folder names). Sharing
// this keeps that validation from drifting between adapters.
export function createFolderMapper(mapping: Record<Folder, string>): (f: Folder) => string {
  return function mapFolder(f: Folder): string {
    const key = String(f).trim().toUpperCase();
    const value = mapping[key as Folder];
    if (!value) throw new Error(`unknown folder: ${f}. Valid: INBOX, SENT, DRAFTS, TRASH, SPAM.`);
    return value;
  };
}

export interface EmailSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface EmailFull extends EmailSummary {
  cc: string;
  body: string;
  attachments: EmailAttachment[];
}

export interface ListOptions {
  folder?: Folder;
  limit?: number;
  unreadOnly?: boolean;
}

export interface SearchOptions {
  from?: string;
  to?: string;
  subject?: string;
  // Free-text search across sender, subject, and body (provider-native
  // full-text search). Distinct from `subject`, which scopes matching to the
  // subject field only. Restores the body/content search capability that the
  // structured DSL (PR #328) dropped when it replaced the old raw query
  // string — there was previously no field that could match, for example, an
  // invoice number or phrase mentioned only in the message body.
  text?: string;
  unread?: boolean;
  sinceDays?: number;
  folder?: Folder;
  limit?: number;
}

export interface ComposeOptions {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
}

export interface EmailAdapter {
  list(opts: ListOptions): Promise<EmailSummary[]>;
  read(id: string): Promise<EmailFull>;
  search(opts: SearchOptions): Promise<EmailSummary[]>;
  draft(opts: ComposeOptions): Promise<{ draftId: string }>;
  // messageId is null when the provider's send API does not return a real
  // id for the message it just sent (e.g. Microsoft Graph's POST /sendMail
  // answers 202 Accepted with no Location header for a direct, non-reply
  // send). Adapters must NOT fabricate an id in that case — null signals
  // honestly that no id is available.
  send(opts: ComposeOptions): Promise<{ messageId: string | null }>;
  getAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<{ filename: string; mimeType: string; data: Buffer }>;
}

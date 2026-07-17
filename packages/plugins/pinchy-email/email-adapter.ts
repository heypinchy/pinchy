export type Folder = "INBOX" | "SENT" | "DRAFTS" | "TRASH" | "SPAM";

// Escape a value for embedding inside a double-quoted query string: backslashes
// BEFORE quotes so a trailing "\" can't escape the closing quote. Used by both
// the Gmail query builder and the Graph $search KQL builder; each adapter keeps
// its own wrapping/quoting policy on top of this.
export function escapeDoubleQuoted(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

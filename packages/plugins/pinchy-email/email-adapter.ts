export type Folder = "INBOX" | "SENT" | "DRAFTS" | "TRASH" | "SPAM";

export interface EmailSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface EmailFull extends EmailSummary {
  cc: string;
  body: string;
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
  send(opts: ComposeOptions): Promise<{ messageId: string }>;
}

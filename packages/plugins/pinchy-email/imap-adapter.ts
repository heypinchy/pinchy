import type {
  EmailAdapter,
  EmailSummary,
  EmailFull,
  ListOptions,
  SearchOptions,
  ComposeOptions,
} from "./email-adapter.js";

export interface ImapAdapterOptions {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
  security: "tls" | "starttls" | "none";
}

// Skeleton only — method bodies are filled in by later tasks (folders/list/
// search/read/draft/send). See the pinchy-email IMAP/SMTP implementation plan.
export class ImapAdapter implements EmailAdapter {
  constructor(private opts: ImapAdapterOptions) {}

  async list(_opts: ListOptions): Promise<EmailSummary[]> {
    throw new Error("not implemented");
  }

  async read(_id: string): Promise<EmailFull> {
    throw new Error("not implemented");
  }

  async search(_opts: SearchOptions): Promise<EmailSummary[]> {
    throw new Error("not implemented");
  }

  async draft(_opts: ComposeOptions): Promise<{ draftId: string }> {
    throw new Error("not implemented");
  }

  async send(_opts: ComposeOptions): Promise<{ messageId: string | null }> {
    throw new Error("not implemented");
  }

  async getAttachment(
    _messageId: string,
    _attachmentId: string,
  ): Promise<{ filename: string; mimeType: string; data: Buffer }> {
    throw new Error("not implemented");
  }
}

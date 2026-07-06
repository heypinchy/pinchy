import type {
  EmailAdapter,
  EmailSummary,
  EmailFull,
  ListOptions,
  SearchOptions,
  ComposeOptions,
  Folder,
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

export interface ImapMailbox {
  path: string;
  specialUse: string | undefined;
  flags: Set<string>;
}

// RFC 6154 SPECIAL-USE attributes, mapped to our canonical folders. There is
// no \Inbox SPECIAL-USE flag — INBOX is always the literal mailbox path
// "INBOX", so it is handled separately below rather than through this table.
const SPECIAL_USE_TO_FOLDER: Record<string, Exclude<Folder, "INBOX">> = {
  "\\Sent": "SENT",
  "\\Drafts": "DRAFTS",
  "\\Trash": "TRASH",
  "\\Junk": "SPAM",
};

// Name heuristics for servers that don't advertise SPECIAL-USE, covering
// common English variants and a few localized (e.g. German) names.
const NAME_HEURISTICS: Record<Exclude<Folder, "INBOX">, RegExp> = {
  SENT: /^(sent|sent items|sent mail|gesendet)$/i,
  DRAFTS: /^(drafts?|entwürfe)$/i,
  TRASH:
    /^(trash|bin|deleted|deleted items|deleted messages|papierkorb)$/i,
  SPAM: /^(spam|junk|junk e-?mail)$/i,
};

// Resolves each canonical Folder to the real server mailbox path. Prefers
// RFC 6154 SPECIAL-USE flags (authoritative, server-declared intent) and
// falls back to a case-insensitive name match against common English and
// localized folder names. INBOX is always the literal "INBOX". A folder that
// matches neither is left unset rather than guessed — callers must handle a
// missing key explicitly instead of silently operating on the wrong mailbox.
export function resolveFolders(
  mailboxes: ImapMailbox[],
): Partial<Record<Folder, string>> {
  const result: Partial<Record<Folder, string>> = { INBOX: "INBOX" };

  for (const box of mailboxes) {
    if (box.path.toUpperCase() === "INBOX") continue;

    const bySpecialUse = box.specialUse
      ? SPECIAL_USE_TO_FOLDER[box.specialUse]
      : undefined;
    if (bySpecialUse && !result[bySpecialUse]) {
      result[bySpecialUse] = box.path;
      continue;
    }
  }

  for (const box of mailboxes) {
    if (box.path.toUpperCase() === "INBOX") continue;

    for (const folder of Object.keys(NAME_HEURISTICS) as Array<
      Exclude<Folder, "INBOX">
    >) {
      if (result[folder]) continue;
      if (NAME_HEURISTICS[folder].test(box.path)) {
        result[folder] = box.path;
      }
    }
  }

  return result;
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

import { ImapFlow } from "imapflow";
import type { FetchMessageObject, ListResponse } from "imapflow";
import { simpleParser } from "mailparser";
import type { AddressObject, ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type {
  EmailAdapter,
  EmailAttachment,
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
  TRASH: /^(trash|bin|deleted|deleted items|deleted messages|papierkorb)$/i,
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

const DEFAULT_LIMIT = 20;
const MS_PER_DAY = 86_400_000;

// Maps the structured SearchOptions DSL to an imapflow SearchObject. Pure and
// deterministic: `now` is supplied by the caller (never read internally via
// Date.now()/new Date()) so `sinceDays` resolves to an exact, testable date.
// `folder` and `limit` are NOT search criteria — they drive mailbox selection
// and result slicing in the search()/list() methods, not the IMAP SEARCH
// command itself.
export function buildImapSearch(
  opts: SearchOptions,
  now: Date,
): Record<string, unknown> {
  const criteria: Record<string, unknown> = {};
  if (opts.from) criteria.from = opts.from;
  if (opts.to) criteria.to = opts.to;
  if (opts.subject) criteria.subject = opts.subject;
  if (opts.text) criteria.body = opts.text;
  if (opts.unread === true) criteria.seen = false;
  if (opts.unread === false) criteria.seen = true;
  if (opts.sinceDays != null) {
    criteria.since = new Date(now.getTime() - opts.sinceDays * MS_PER_DAY);
  }
  return criteria;
}

const SNIPPET_LENGTH = 200;

// mailparser types to/cc as a single AddressObject OR an array of them (one
// per repeated To:/Cc: header line). Both siblings only ever see a single
// combined address string from their provider APIs, so this collapses either
// shape into the same ".text" rendering convention used elsewhere.
function addressText(
  addr: AddressObject | AddressObject[] | undefined,
): string {
  if (!addr) return "";
  return Array.isArray(addr) ? addr.map((a) => a.text).join(", ") : addr.text;
}

// Very small HTML-to-text fallback for when a message has no text/plain
// part. mailparser already derives ParsedMail.text from html in the common
// case (via its bundled html-to-text), so this only matters for the rare
// case where text is genuinely absent — kept intentionally simple rather
// than pulling in another HTML-parsing dependency for a fallback path.
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// First ~200 chars of the body, whitespace-collapsed onto a single line —
// matches the short, single-line preview shape Gmail's snippet and Graph's
// bodyPreview already give us natively.
function makeSnippet(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, SNIPPET_LENGTH);
}

function extractBody(parsed: ParsedMail): string {
  if (parsed.text) return parsed.text;
  if (parsed.html) return stripHtml(parsed.html);
  return "";
}

function toAttachments(parsed: ParsedMail): EmailAttachment[] {
  return parsed.attachments.map((a, i) => ({
    id: a.contentId ?? a.cid ?? String(i),
    filename: a.filename ?? "",
    mimeType: a.contentType,
    size: a.size,
  }));
}

// Guards against MIME/SMTP header injection via CR/LF in a header value —
// e.g. `to: "victim@example.com\r\nBcc: attacker@evil.com"` could otherwise
// inject an extra header line. The Gmail adapter's buildRawMessage() strips
// CR/LF/NUL silently before composing its raw message; IMAP instead throws a
// clear error so a caller passing attacker-controlled input finds out rather
// than having it silently rewritten out from under it.
function assertNoHeaderInjection(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `${field} contains a line break, which is not allowed (possible header injection attempt)`,
    );
  }
}

function assertComposeOptionsSafe(opts: ComposeOptions): void {
  assertNoHeaderInjection("to", opts.to);
  assertNoHeaderInjection("subject", opts.subject);
}

function toSummary(m: FetchMessageObject): EmailSummary {
  const envelope = m.envelope;
  return {
    id: String(m.uid),
    from: envelope?.from?.[0]?.address ?? "",
    to: envelope?.to?.map((a) => a.address ?? "").join(", ") ?? "",
    subject: envelope?.subject ?? "",
    date: envelope?.date ? new Date(envelope.date).toISOString() : "",
    snippet: "",
    unread: !(m.flags?.has("\\Seen") ?? false),
  };
}

export class ImapAdapter implements EmailAdapter {
  constructor(private opts: ImapAdapterOptions) {}

  private async withClient<T>(
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = new ImapFlow({
      host: this.opts.imapHost,
      port: this.opts.imapPort,
      secure: this.opts.security === "tls",
      auth: {
        user: this.opts.username,
        pass: this.opts.password,
      },
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  // Resolves a canonical Folder to a real mailbox path on the server. Throws
  // when the folder can't be resolved rather than silently falling back to
  // the wrong mailbox — INBOX always resolves via resolveFolders().
  private async resolveMailboxPath(
    client: ImapFlow,
    folder: Folder,
  ): Promise<string> {
    const mailboxes = (await client.list()) as ListResponse[];
    const resolved = resolveFolders(
      mailboxes.map((box) => ({
        path: box.path,
        specialUse: box.specialUse,
        flags: box.flags,
      })),
    );
    const path = resolved[folder];
    if (!path) {
      throw new Error(`folder ${folder} not found on server`);
    }
    return path;
  }

  private async fetchSummaries(
    client: ImapFlow,
    path: string,
    criteria: Record<string, unknown>,
    limit: number,
  ): Promise<EmailSummary[]> {
    await client.mailboxOpen(path);
    const uids = await client.search(criteria, { uid: true });
    if (!uids || uids.length === 0) return [];

    // Newest first: UIDs generally increase with arrival order, and the
    // sibling adapters (Gmail/Graph) both return newest-first by default.
    const sorted = [...uids].sort((a, b) => b - a);
    const wanted = sorted.slice(0, limit);

    const summaries: EmailSummary[] = [];
    for await (const msg of client.fetch(
      wanted,
      { envelope: true, flags: true },
      { uid: true },
    )) {
      summaries.push(toSummary(msg));
    }
    summaries.sort((a, b) => Number(b.id) - Number(a.id));
    return summaries.slice(0, limit);
  }

  async list(opts: ListOptions): Promise<EmailSummary[]> {
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const criteria: Record<string, unknown> = opts.unreadOnly
      ? { seen: false }
      : { all: true };
    return this.withClient(async (client) => {
      const path = await this.resolveMailboxPath(client, folder);
      return this.fetchSummaries(client, path, criteria, limit);
    });
  }

  // Fetches and parses a message by UID from INBOX. IMAP UIDs are only
  // unique within a mailbox, and read()/getAttachment() receive just an id —
  // no folder — so this (like the sibling adapters, which use provider-global
  // message ids) treats INBOX as the operating mailbox for by-id lookups.
  // Messages filed elsewhere are out of scope for v1; encoding the folder
  // into the id would be a bigger design change than this task calls for.
  private async fetchParsed(
    client: ImapFlow,
    id: string,
  ): Promise<{ parsed: ParsedMail; unread: boolean }> {
    await client.mailboxOpen("INBOX");
    const msg = await client.fetchOne(
      Number(id),
      { source: true, flags: true },
      { uid: true },
    );
    if (!msg || !msg.source) {
      throw new Error(`message ${id} not found`);
    }
    const parsed = await simpleParser(msg.source);
    const unread = !(msg.flags?.has("\\Seen") ?? false);
    return { parsed, unread };
  }

  async read(id: string): Promise<EmailFull> {
    return this.withClient(async (client) => {
      const { parsed, unread } = await this.fetchParsed(client, id);
      const body = extractBody(parsed);
      return {
        id,
        from: parsed.from?.text ?? "",
        to: addressText(parsed.to),
        cc: addressText(parsed.cc),
        subject: parsed.subject ?? "",
        date: parsed.date?.toISOString() ?? "",
        snippet: makeSnippet(body),
        unread,
        body,
        attachments: toAttachments(parsed),
      };
    });
  }

  async search(opts: SearchOptions): Promise<EmailSummary[]> {
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const criteria = buildImapSearch(opts, new Date());
    return this.withClient(async (client) => {
      const path = await this.resolveMailboxPath(client, folder);
      return this.fetchSummaries(client, path, criteria, limit);
    });
  }

  // Builds a draft as a raw RFC822 message and APPENDs it directly to the
  // server's DRAFTS mailbox with the \Draft flag — there is no IMAP "create
  // draft" verb, APPEND is how every IMAP client does this. Unlike Gmail/
  // Graph, an unresolvable DRAFTS folder is a hard error (v1 behavior): we
  // don't guess at a fallback mailbox to file a draft into.
  async draft(opts: ComposeOptions): Promise<{ draftId: string }> {
    assertComposeOptionsSafe(opts);

    const raw = await new MailComposer({
      from: this.opts.username,
      to: opts.to,
      subject: opts.subject,
      text: opts.body,
      ...(opts.replyTo ? { inReplyTo: opts.replyTo } : {}),
    })
      .compile()
      .build();

    return this.withClient(async (client) => {
      const draftsPath = await this.resolveMailboxPath(client, "DRAFTS");
      const res = await client.append(draftsPath, raw, ["\\Draft"]);
      // imapflow's append() resolves to `AppendResponseObject | false`; `uid`
      // is only present when the server advertises the UIDPLUS extension. Fall
      // back to a stable non-empty id (the destination path) rather than
      // fabricating a fake numeric uid when the server doesn't report one.
      const uid = res && typeof res === "object" ? res.uid : undefined;
      return { draftId: uid != null ? String(uid) : draftsPath };
    });
  }

  // Sends via SMTP using nodemailer, independent of the IMAP connection used
  // by the other methods (IMAP has no "send" verb — SMTP is the wire protocol
  // that actually delivers mail).
  async send(opts: ComposeOptions): Promise<{ messageId: string | null }> {
    assertComposeOptionsSafe(opts);

    const transport = nodemailer.createTransport({
      host: this.opts.smtpHost,
      port: this.opts.smtpPort,
      secure: this.opts.security === "tls",
      requireTLS: this.opts.security === "starttls",
      auth: {
        user: this.opts.username,
        pass: this.opts.password,
      },
    });
    try {
      const info = await transport.sendMail({
        from: this.opts.username,
        to: opts.to,
        subject: opts.subject,
        text: opts.body,
        ...(opts.replyTo ? { inReplyTo: opts.replyTo } : {}),
      });
      return { messageId: info.messageId ?? null };
    } finally {
      transport.close?.();
    }
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ filename: string; mimeType: string; data: Buffer }> {
    return this.withClient(async (client) => {
      const { parsed } = await this.fetchParsed(client, messageId);
      const match = parsed.attachments.find(
        (a, i) => (a.contentId ?? a.cid ?? String(i)) === attachmentId,
      );
      if (!match) {
        throw new Error(`attachment ${attachmentId} not found`);
      }
      return {
        filename: match.filename ?? "",
        mimeType: match.contentType,
        data: match.content,
      };
    });
  }
}

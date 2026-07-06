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

// A single stored `security` field can't be simultaneously correct for IMAP
// (implicit-TLS 993) and SMTP (STARTTLS submission 587), so encryption mode is
// keyed off the standard port instead:
//   security === "none"        → no encryption          (secure:false, requireTLS:false)
//   implicit-TLS ports 993/465 → implicit TLS           (secure:true,  requireTLS:false)
//   any other port (143/587/25)→ STARTTLS opportunistic (secure:false, requireTLS:true)
const IMPLICIT_TLS_PORTS = new Set([993, 465]);
export function tlsModeForPort(
  port: number,
  security: string,
): { secure: boolean; requireTLS: boolean } {
  if (security === "none") return { secure: false, requireTLS: false };
  const implicit = IMPLICIT_TLS_PORTS.has(port);
  return { secure: implicit, requireTLS: !implicit };
}

// IMAP UIDs are only unique within a single mailbox, so a message id must carry
// the mailbox path it belongs to — otherwise a UID from SENT looked up in INBOX
// resolves to the wrong message (or none). The mailbox path is base64url-encoded
// because real paths contain '.', '/', and spaces; the uid is a plain integer
// prefix so ids stay roughly human-readable.
export function encodeMessageId(mailboxPath: string, uid: number): string {
  return `${uid}@${Buffer.from(mailboxPath, "utf8").toString("base64url")}`;
}

// Inverse of encodeMessageId. BACKWARD-COMPAT: a bare integer string (no '@')
// is a legacy id from before folder-encoding (or a canned E2E id) and is
// treated as an INBOX uid. Splits on the FIRST '@' so the base64url tail is
// decoded intact.
export function decodeMessageId(id: string): {
  mailboxPath: string;
  uid: number;
} {
  const at = id.indexOf("@");
  if (at === -1) {
    return { mailboxPath: "INBOX", uid: Number(id) };
  }
  const uid = Number(id.slice(0, at));
  const mailboxPath = Buffer.from(id.slice(at + 1), "base64url").toString(
    "utf8",
  );
  return { mailboxPath, uid };
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

    // Match the LAST path segment, not the full path, so hierarchical/prefixed
    // mailboxes like Dovecot's "INBOX.Sent" or "INBOX/Sent Items" still match
    // the anchored heuristics. ImapMailbox carries only `path`, so split on
    // both common hierarchy delimiters ('.' and '/').
    const leaf = box.path.split(/[./]/).pop() ?? box.path;

    for (const folder of Object.keys(NAME_HEURISTICS) as Array<
      Exclude<Folder, "INBOX">
    >) {
      if (result[folder]) continue;
      if (NAME_HEURISTICS[folder].test(leaf)) {
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

function toSummary(m: FetchMessageObject, path: string): EmailSummary {
  const envelope = m.envelope;
  return {
    id: encodeMessageId(path, m.uid),
    from: envelope?.from?.[0]?.address ?? "",
    to: envelope?.to?.map((a) => a.address ?? "").join(", ") ?? "",
    subject: envelope?.subject ?? "",
    date: envelope?.date ? new Date(envelope.date).toISOString() : "",
    snippet: "",
    unread: !(m.flags?.has("\\Seen") ?? false),
  };
}

// Default IMAP/SMTP ports for the GreenMail E2E mock, used only when the
// corresponding _MOCK_HOST env var is set but its _MOCK_PORT sibling isn't.
const DEFAULT_IMAP_MOCK_PORT = 3143;
const DEFAULT_SMTP_MOCK_PORT = 3025;

// Resolved connection settings for a single protocol (IMAP or SMTP): host,
// port, and TLS mode, after applying an env-based mock override on top of
// this.opts. OFF by default — production always uses the stored host/port with
// port-derived TLS; the override only fires when the matching *_MOCK_HOST env
// var AND the explicit PINCHY_INSECURE_MAIL_MOCK opt-in flag are both set
// (e.g. by the E2E GreenMail compose overlay).
interface ResolvedConnection {
  host: string;
  port: number;
  secure: boolean;
}

// SMTP-specific resolved connection: adds requireTLS (STARTTLS), which has
// no IMAP equivalent.
interface ResolvedSmtpConnection extends ResolvedConnection {
  requireTLS: boolean;
}

export class ImapAdapter implements EmailAdapter {
  constructor(private opts: ImapAdapterOptions) {}

  // Resolves the effective IMAP connection: this.opts, unless the insecure mock
  // seam is explicitly opted into. The seam fires ONLY when BOTH IMAP_MOCK_HOST
  // AND PINCHY_INSECURE_MAIL_MOCK==="1" are set — then host/port come from
  // IMAP_MOCK_HOST/IMAP_MOCK_PORT (defaulting to GreenMail's 3143) and secure is
  // forced to false (GreenMail's plain IMAP listener has no TLS). The explicit
  // flag prevents a stray *_MOCK_HOST in production from silently downgrading
  // TLS and redirecting credentials to an attacker-controlled host; a mock host
  // WITHOUT the flag is ignored and the real stored connection is used.
  private resolveImapConnection(): ResolvedConnection {
    const mockHost = process.env.IMAP_MOCK_HOST;
    if (mockHost && process.env.PINCHY_INSECURE_MAIL_MOCK === "1") {
      return {
        host: mockHost,
        port: Number(process.env.IMAP_MOCK_PORT ?? DEFAULT_IMAP_MOCK_PORT),
        secure: false,
      };
    }
    return {
      host: this.opts.imapHost,
      port: this.opts.imapPort,
      secure: tlsModeForPort(this.opts.imapPort, this.opts.security).secure,
    };
  }

  // Resolves the effective SMTP connection: this.opts, unless the insecure mock
  // seam is explicitly opted into. The seam fires ONLY when BOTH SMTP_MOCK_HOST
  // AND PINCHY_INSECURE_MAIL_MOCK==="1" are set — then host/port come from
  // SMTP_MOCK_HOST/SMTP_MOCK_PORT (defaulting to GreenMail's 3025) and
  // secure/requireTLS are both forced off (GreenMail's plain SMTP listener has
  // no TLS/STARTTLS). The explicit flag prevents a stray *_MOCK_HOST in
  // production from silently downgrading TLS and redirecting credentials; a
  // mock host WITHOUT the flag is ignored and the real stored connection used.
  private resolveSmtpConnection(): ResolvedSmtpConnection {
    const mockHost = process.env.SMTP_MOCK_HOST;
    if (mockHost && process.env.PINCHY_INSECURE_MAIL_MOCK === "1") {
      return {
        host: mockHost,
        port: Number(process.env.SMTP_MOCK_PORT ?? DEFAULT_SMTP_MOCK_PORT),
        secure: false,
        requireTLS: false,
      };
    }
    return {
      host: this.opts.smtpHost,
      port: this.opts.smtpPort,
      ...tlsModeForPort(this.opts.smtpPort, this.opts.security),
    };
  }

  private async withClient<T>(
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const conn = this.resolveImapConnection();
    const client = new ImapFlow({
      host: conn.host,
      port: conn.port,
      secure: conn.secure,
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
      summaries.push(toSummary(msg, path));
    }
    // Ids are now folder-encoded, so sort on the decoded uid (newest first)
    // rather than the raw id string.
    summaries.sort(
      (a, b) => decodeMessageId(b.id).uid - decodeMessageId(a.id).uid,
    );
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

  // Fetches and parses a message by its folder-encoded id. The id carries the
  // mailbox path (IMAP UIDs are only unique within a mailbox), so this opens
  // the message's own mailbox rather than hardcoding INBOX — a UID from SENT
  // must be looked up in SENT, not INBOX. Legacy bare-integer ids decode to
  // INBOX for backward compatibility (see decodeMessageId).
  private async fetchParsed(
    client: ImapFlow,
    id: string,
  ): Promise<{ parsed: ParsedMail; unread: boolean }> {
    const decoded = decodeMessageId(id);
    await client.mailboxOpen(decoded.mailboxPath);
    const msg = await client.fetchOne(
      decoded.uid,
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

    const conn = this.resolveSmtpConnection();
    const transport = nodemailer.createTransport({
      host: conn.host,
      port: conn.port,
      secure: conn.secure,
      requireTLS: conn.requireTLS,
      auth: {
        user: this.opts.username,
        pass: this.opts.password,
      },
    });
    let messageId: string | null;
    try {
      const info = await transport.sendMail({
        from: this.opts.username,
        to: opts.to,
        subject: opts.subject,
        text: opts.body,
        ...(opts.replyTo ? { inReplyTo: opts.replyTo } : {}),
      });
      messageId = info.messageId ?? null;
    } finally {
      transport.close?.();
    }

    // Best-effort: file a copy of the sent message into the Sent mailbox so
    // agent-sent mail appears in Sent and in search({folder:"SENT"}) — IMAP
    // APPEND is the standard way clients do this (there is no server-side "save
    // to Sent" hook on the SMTP path). Wrapped in try/catch because it must
    // never fail or alter the send: an unresolvable Sent folder or a rejected
    // APPEND leaves the already-delivered message untouched.
    try {
      const raw = await new MailComposer({
        from: this.opts.username,
        to: opts.to,
        subject: opts.subject,
        text: opts.body,
        ...(opts.replyTo ? { inReplyTo: opts.replyTo } : {}),
      })
        .compile()
        .build();

      await this.withClient(async (client) => {
        const sentPath = await this.resolveMailboxPath(client, "SENT");
        await client.append(sentPath, raw, ["\\Seen"]);
      });
    } catch {
      // Swallow: archiving to Sent is best-effort and must not fail the send.
    }

    return { messageId };
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

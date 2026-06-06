import { google } from "googleapis";
import type {
  EmailAdapter,
  Folder,
  ListOptions,
  SearchOptions,
  ComposeOptions,
  EmailSummary,
  EmailFull,
} from "./email-adapter.js";

export type { EmailSummary, EmailFull };

const FOLDER_TO_GMAIL_LABEL: Record<Folder, string> = {
  INBOX: "INBOX",
  SENT: "SENT",
  DRAFTS: "DRAFT",
  TRASH: "TRASH",
  SPAM: "SPAM",
};

function mapFolder(f: Folder): string {
  const label = FOLDER_TO_GMAIL_LABEL[f];
  if (!label) throw new Error(`unknown folder: ${f}. Valid: INBOX, SENT, DRAFTS, TRASH, SPAM.`);
  return label;
}

function buildGmailQuery(opts: SearchOptions): string {
  const parts: string[] = [];
  // Escape backslashes BEFORE quotes so a trailing "\" can't escape the closing
  // quote (e.g. `foo\` → `"foo\\"`, not the broken `"foo\"`).
  const quote = (v: string) =>
    /[\s"\\]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
  if (opts.from) parts.push(`from:${quote(opts.from)}`);
  if (opts.to) parts.push(`to:${quote(opts.to)}`);
  if (opts.subject) parts.push(`subject:${quote(opts.subject)}`);
  if (opts.unread) parts.push("is:unread");
  if (opts.sinceDays != null) parts.push(`newer_than:${opts.sinceDays}d`);
  if (opts.folder) parts.push(`label:${mapFolder(opts.folder)}`);
  if (parts.length === 0) throw new Error("search requires at least one filter field");
  return parts.join(" ");
}

export class GmailAdapter implements EmailAdapter {
  private gmail: ReturnType<typeof google.gmail>;

  constructor(opts: { accessToken: string }) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: opts.accessToken });
    // GMAIL_API_BASE_URL allows E2E tests to redirect gmail API calls to a
    // local mock server instead of https://gmail.googleapis.com/
    const rootUrl = process.env.GMAIL_API_BASE_URL;
    this.gmail = google.gmail({ version: "v1", auth, ...(rootUrl ? { rootUrl } : {}) });
  }

  async list(opts: ListOptions): Promise<EmailSummary[]> {
    const { folder, limit = 20, unreadOnly } = opts;

    return this.fetchSummaries({
      maxResults: limit,
      q: unreadOnly ? "is:unread" : undefined,
      labelIds: folder ? [mapFolder(folder)] : undefined,
    });
  }

  async read(id: string): Promise<EmailFull> {
    const response = await this.gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });

    const data = response.data;
    if (!data.payload) throw new Error(`Gmail API returned message without payload for id: ${id}`);
    const payload = data.payload;

    return {
      id: data.id!,
      from: getHeader(payload.headers, "From"),
      to: getHeader(payload.headers, "To"),
      cc: getHeader(payload.headers, "Cc"),
      subject: getHeader(payload.headers, "Subject"),
      date: getHeader(payload.headers, "Date"),
      snippet: data.snippet ?? "",
      unread: data.labelIds?.includes("UNREAD") ?? false,
      body: extractBody(payload),
    };
  }

  async search(opts: SearchOptions): Promise<EmailSummary[]> {
    const { limit = 20, ...dslOpts } = opts;
    const q = buildGmailQuery(dslOpts);

    return this.fetchSummaries({
      maxResults: limit,
      q,
      labelIds: undefined,
    });
  }

  private async fetchSummaries(listOpts: {
    maxResults: number;
    q?: string;
    labelIds?: string[];
  }): Promise<EmailSummary[]> {
    const response = await this.gmail.users.messages.list({
      userId: "me",
      ...listOpts,
    });

    const messages = response.data.messages ?? [];

    return Promise.all(
      messages.map(async (msg) => {
        const detail = await this.gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });

        return {
          id: detail.data.id!,
          from: getHeader(detail.data.payload?.headers, "From"),
          to: getHeader(detail.data.payload?.headers, "To"),
          subject: getHeader(detail.data.payload?.headers, "Subject"),
          date: getHeader(detail.data.payload?.headers, "Date"),
          snippet: detail.data.snippet ?? "",
          unread: detail.data.labelIds?.includes("UNREAD") ?? false,
        };
      }),
    );
  }

  async draft(opts: ComposeOptions): Promise<{ draftId: string }> {
    const raw = buildRawMessage(opts);

    const response = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw },
      },
    });

    return { draftId: response.data.id! };
  }

  async send(opts: ComposeOptions): Promise<{ messageId: string }> {
    const raw = buildRawMessage(opts);

    const response = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return { messageId: response.data.id! };
  }
}

function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined | null,
  name: string,
): string {
  return headers?.find((h) => h.name === name)?.value ?? "";
}

interface MimePart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: MimePart[] | null;
}

function extractBody(payload: MimePart): string {
  // Single-part message
  if (!payload.parts && payload.body?.data) {
    return decodeBase64url(payload.body.data);
  }

  // Multipart: recursively search for text/plain, fallback to text/html
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) {
    return decodeBase64url(plain.body.data);
  }

  const html = findPart(payload, "text/html");
  if (html?.body?.data) {
    return decodeBase64url(html.body.data);
  }

  return "";
}

function findPart(part: MimePart, mimeType: string): MimePart | null {
  if (part.mimeType === mimeType && part.body?.data) {
    return part;
  }

  if (part.parts) {
    for (const child of part.parts) {
      const found = findPart(child, mimeType);
      if (found) return found;
    }
  }

  return null;
}

function decodeBase64url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n\0]/g, "");
}

function buildRawMessage(opts: ComposeOptions): string {
  const lines: string[] = [
    `To: ${sanitizeHeader(opts.to)}`,
    `Subject: ${sanitizeHeader(opts.subject)}`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];

  if (opts.replyTo) {
    const sanitized = sanitizeHeader(opts.replyTo);
    lines.push(`In-Reply-To: ${sanitized}`);
    lines.push(`References: ${sanitized}`);
  }

  lines.push("", opts.body);

  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

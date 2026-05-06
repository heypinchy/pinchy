import { google } from "googleapis";

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
  folder?: string;
  limit?: number;
  unreadOnly?: boolean;
}

export interface SearchOptions {
  query: string;
  limit?: number;
}

export interface ComposeOptions {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
}

export class GmailAdapter {
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
      labelIds: folder ? [folder] : undefined,
    });
  }

  async read(id: string): Promise<EmailFull> {
    const response = await this.gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });

    const data = response.data;
    const payload = data.payload!;

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
    const { query, limit = 20 } = opts;

    return this.fetchSummaries({
      maxResults: limit,
      q: query,
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
    lines.push(`In-Reply-To: ${sanitizeHeader(opts.replyTo)}`);
  }

  lines.push("", opts.body);

  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

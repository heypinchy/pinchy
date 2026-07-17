import type { EmailListItem, EmailPort, EmailReadResult } from "@/lib/email-workflows/lister";

/**
 * The Gmail mailbox port for the reconciliation sweep.
 *
 * Runs Pinchy-side from decrypted stored credentials, with no agent session.
 * Stateless HTTP, so it implements no `close()`.
 *
 * Spoken over plain `fetch`, deliberately NOT the `googleapis` SDK: the plugin
 * carries that dependency, the web app does not, and two endpoints do not
 * justify pulling an SDK into it (the web app's google-oauth.ts talks raw HTTP
 * for the same reason).
 *
 * Unlike Graph, Gmail message ids are stable — Gmail has labels, not folders, so
 * "moving" a mail is a relabel and the id never changes. No immutable-id dance
 * is needed for the ledger's claim key here.
 */

const DEFAULT_LABEL = "INBOX";

/** Same convention as the pinchy-email plugin's gmail adapter (E2E mock redirect). */
function gmailBase(): string {
  return process.env.GMAIL_API_BASE_URL ?? "https://gmail.googleapis.com";
}

interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  /** ms since epoch, as a string. */
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

/** RFC 5322 header names are case-insensitive; Gmail echoes the sender's spelling. */
function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === wanted)?.value;
}

/**
 * Walk the MIME part tree and collect the parts a human would call an
 * attachment: a named part that is not `Content-Disposition: inline`. An inline
 * part is the HTML body's own embedded image, and counting it would fire every
 * workflow's `hasAttachment` filter on ordinary newsletters — the same trap as
 * IMAP's disposition and Graph's isInline.
 */
function collectGmailAttachments(part?: GmailPart): { mimeType: string; filename?: string }[] {
  const found: { mimeType: string; filename?: string }[] = [];
  const walk = (p?: GmailPart): void => {
    if (!p) return;
    if (p.filename && p.filename.length > 0) {
      const disposition = headerValue(p.headers, "Content-Disposition") ?? "";
      if (!/^\s*inline/i.test(disposition)) {
        found.push({ mimeType: p.mimeType ?? "application/octet-stream", filename: p.filename });
      }
    }
    for (const child of p.parts ?? []) walk(child);
  };
  walk(part);
  return found;
}

/** Gmail's message shape → the lister's raw-shaped {@link EmailReadResult}. */
export function mapGmailMessage(input: { folder: string; message: GmailMessage }): EmailReadResult {
  const { folder, message } = input;
  const headers = message.payload?.headers;
  // Prefer the Date header; fall back to Gmail's internalDate (ms since epoch,
  // as a string). Without the fallback a mail with no Date header would be
  // rejected by the lister as unparseable and silently dropped by its
  // poison-message isolation.
  const dateHeader = headerValue(headers, "Date");
  const internal = message.internalDate ? Number(message.internalDate) : NaN;
  const date = dateHeader ?? (Number.isFinite(internal) ? new Date(internal).toISOString() : "");

  return {
    id: message.id,
    // Raw header values pass straight through: the lister is what unwraps
    // `Display Name <addr>` and splits recipient lists, and it already handles
    // quoted names containing commas.
    from: headerValue(headers, "From") ?? "",
    to: headerValue(headers, "To") ?? "",
    cc: headerValue(headers, "Cc") ?? "",
    subject: headerValue(headers, "Subject") ?? "",
    date,
    folder,
    messageIdHeader: headerValue(headers, "Message-ID"),
    attachments: collectGmailAttachments(message.payload),
  };
}

/** Build an {@link EmailPort} over the Gmail API from decrypted credentials. */
export function createGmailPort(credentials: unknown): EmailPort {
  const creds = credentials as { accessToken?: unknown };
  if (typeof creds?.accessToken !== "string" || creds.accessToken.length === 0) {
    throw new Error("Gmail port: stored credentials carry no access token");
  }
  const accessToken = creds.accessToken;

  async function gmailGet<T>(path: string): Promise<T> {
    const res = await fetch(`${gmailBase()}/gmail/v1${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) {
      // Never answer a failed call as an empty mailbox — that reads as "nothing
      // new" and silently retires the workflow while its status stays `active`.
      const body = await res.text().catch(() => "");
      throw new Error(`Gmail port: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  return {
    async search(opts): Promise<EmailListItem[]> {
      const parts: string[] = [];
      // Scope the folder with labelIds, NEVER with `q`. Gmail's query language
      // only documents `in:trash`/`in:spam` for folder scoping; `label:INBOX`
      // works only through the q parser's undocumented aliasing, and Gmail
      // search excludes Trash/Spam by default — so scoping through `q` risks
      // SILENTLY EMPTY results, which for a sweep is the worst failure there is:
      // it reads as "nothing new" while the workflow looks perfectly healthy.
      // The pinchy-email plugin's adapter learned this the hard way.
      parts.push(`labelIds=${encodeURIComponent((opts.folder ?? DEFAULT_LABEL).toUpperCase())}`);
      if (opts.limit) parts.push(`maxResults=${encodeURIComponent(String(opts.limit))}`);
      if (opts.sinceDays) {
        // `q` carries only the time window — day granularity, a coarse
        // pre-filter. The sweep's own sinceTs watermark is what actually bounds
        // the window.
        parts.push(`q=${encodeURIComponent(`newer_than:${opts.sinceDays}d`)}`);
      }
      const listed = await gmailGet<{ messages?: { id: string }[] }>(
        `/users/me/messages?${parts.join("&")}`
      );
      // Gmail omits `messages` entirely (rather than sending []) when nothing
      // matches.
      return (listed.messages ?? []).map((m) => ({ id: m.id }));
    },

    async read(id): Promise<EmailReadResult> {
      // `format=full` is the only format that carries the MIME part tree, which
      // is where attachment metadata lives. It also ships the text body's bytes,
      // which we ignore — Gmail has no "structure without body" format, and
      // attachment BYTES are not included either way (only their attachmentId).
      const message = await gmailGet<GmailMessage>(
        `/users/me/messages/${encodeURIComponent(id)}?format=full`
      );
      // Report the mailbox-level label rather than guessing from labelIds: the
      // workflow's filter re-checks `folder` by name and the listing is scoped
      // to it by construction.
      return mapGmailMessage({ folder: DEFAULT_LABEL, message });
    },
  };
}

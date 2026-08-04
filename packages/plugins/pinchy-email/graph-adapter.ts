import {
  createFolderMapper,
  escapeDoubleQuoted,
  resolveInsecureMockBaseUrl,
  stripHtml,
  MAX_ATTACHMENT_BYTES,
} from "./email-adapter.js";
import type {
  EmailAdapter,
  EmailAttachment,
  ListOptions,
  SearchOptions,
  ComposeOptions,
  EmailSummary,
  EmailFull,
} from "./email-adapter.js";

// Graph's attachment-get endpoint wraps the file's base64 payload inside a
// JSON body — GET /me/messages/{id}/attachments/{id} — so a naive
// `await res.json()` fully materializes that whole body in memory BEFORE
// index.ts's post-decode length check on the returned buffer ever runs. A
// 500 MB attachment (or a provider that misreports its own size) would OOM
// the process before the 25 MB cap (MAX_ATTACHMENT_BYTES) ever gets a chance
// to fire.
//
// Base64 inflates the decoded byte count by ~4/3 (with padding), so
// MAX_ATTACHMENT_BYTES worth of file content becomes MAX_ATTACHMENT_BYTES *
// 4/3 ≈ 33.3 MB of base64 text inside the response; 40 MB leaves headroom for
// the surrounding JSON envelope (id/name/contentType/... fields) on top of
// that.
const MAX_ATTACHMENT_RESPONSE_BYTES = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 7 * 1024 * 1024;

const mapFolder = createFolderMapper({
  INBOX: "inbox",
  SENT: "sentitems",
  DRAFTS: "drafts",
  TRASH: "deleteditems",
  SPAM: "junkemail",
});

const SUMMARY_SELECT = "id,subject,bodyPreview,receivedDateTime,from,toRecipients,isRead";

// Escape a value for use inside an OData single-quoted string literal. OData
// escapes a single quote by doubling it; without this an apostrophe in a search
// term (e.g. "O'Brien") would terminate the literal early and break — or inject
// into — the $filter expression.
function odataString(v: string): string {
  return v.replace(/'/g, "''");
}

// Build a `field:value` KQL term for use inside the outer $search="..." string.
// A property value that contains whitespace (or a double-quote/backslash) is
// wrapped in ESCAPED inner quotes so KQL treats it as a single phrase scoped
// to `field` — e.g. `subject:\"quarterly report\"`, which renders inside the
// outer $search="..." wrapper as a live KQL phrase quote. Without this, Graph's
// $search="subject:quarterly report" only scopes "quarterly" to subject;
// "report" becomes an unscoped free-text term matching from/subject/body
// anywhere, returning unrelated mail. A single safe token (no whitespace/
// special chars) is left unquoted to avoid over-quoting. This mirrors Gmail's
// buildGmailQuery quoting policy (same /[\s"\\]/ trigger) so both providers
// behave identically for the same tool input.
function kqlTerm(field: string, v: string): string {
  const value = /[\s"\\]/.test(v) ? `\\"${escapeDoubleQuoted(v)}\\"` : v;
  return `${field}:${value}`;
}

// Same phrase-quoting policy as kqlTerm, but for a BARE free-text term (no
// `field:` prefix) — Graph's $search does full-text across from/subject/body
// when a term isn't scoped to a property. Kept as a separate helper (rather
// than kqlTerm(field, v) with an empty field) so the "no colon for a bare
// term" shape can't be accidentally reintroduced by a future edit to kqlTerm.
function kqlBareTerm(v: string): string {
  return /[\s"\\]/.test(v) ? `\\"${escapeDoubleQuoted(v)}\\"` : v;
}

interface GraphMessage {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  receivedDateTime: string | null;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  isRead: boolean;
}

// A Graph attachment collection item. `@odata.type` distinguishes fileAttachment
// (has downloadable contentBytes) from itemAttachment / referenceAttachment
// (embedded messages / cloud links, which cannot be downloaded as bytes).
interface GraphAttachment {
  "@odata.type"?: string;
  id: string;
  name: string | null;
  contentType: string | null;
  size: number | null;
  isInline: boolean;
  contentBytes?: string | null;
}

const FILE_ATTACHMENT_TYPE = "#microsoft.graph.fileAttachment";

// External API call — bounds a hung Microsoft Graph endpoint / network
// blackhole.
const FETCH_TIMEOUT_MS = 30_000;

// The attachment download carries the whole file as base64 inside the JSON
// body — up to the 25 MB the tools layer accepts, ~33 MB on the wire. An
// AbortSignal covers the body read too, not just the response headers, so the
// bound that is generous for a metadata call would abort a working-but-slow
// download well before it finishes. Give that one path its own.
const ATTACHMENT_TIMEOUT_MS = 120_000;

// Microsoft Graph v1.0 message-listing endpoints require every property named
// in $orderby to also appear in $filter, in the same order, ahead of any other
// filter properties — violating this returns HTTP 400 InefficientFilter ("The
// restriction or sort order is too complex for this operation"). This adapter
// always orders by receivedDateTime desc, so whenever a $filter is also
// present, a receivedDateTime predicate must lead it. When the caller has no
// receivedDateTime predicate of their own (e.g. a plain isRead filter), prepend
// the sentinel `receivedDateTime ge 1970-01-01T00:00:00Z`, which matches every
// message and is the standard documented workaround for InefficientFilter.
const RECEIVED_DATE_TIME_SENTINEL = "receivedDateTime ge 1970-01-01T00:00:00Z";

function buildOrderedFilter(filters: string[]): string | undefined {
  if (filters.length === 0) return undefined;
  const hasReceivedDateTime = filters.some((f) => f.startsWith("receivedDateTime "));
  const ordered = hasReceivedDateTime ? filters : [RECEIVED_DATE_TIME_SENTINEL, ...filters];
  return ordered.join(" and ");
}

// Microsoft Graph returns `body.content` verbatim in whatever
// `body.contentType` ("text" or "html") the message was stored in, and most
// Outlook mail is stored as html — so without this the model reads raw markup
// where IMAP hands it text. The size ceiling that keeps `email_read` out of
// OpenClaw's blind mid-JSON truncation is NOT here: it is applied once at the
// tool boundary (`truncateEmailBody`, see index.ts) because every adapter's
// body is equally unbounded, and a per-adapter cap is a list that goes stale
// the first time a fourth provider lands.
function extractBody(body: { contentType?: string; content?: string } | undefined): string {
  const raw = body?.content ?? "";
  // Graph documents the enum as lowercase `text`/`html`, but a case-sensitive
  // compare is one unexpected payload away from handing the model a body of
  // pure markup — cheap to not depend on.
  return body?.contentType?.toLowerCase() === "html" ? stripHtml(raw) : raw;
}

function toSummary(m: GraphMessage): EmailSummary {
  return {
    id: m.id,
    from: m.from?.emailAddress?.address ?? "",
    to: m.toRecipients?.map((r) => r.emailAddress?.address ?? "").join(", ") ?? "",
    subject: m.subject ?? "",
    date: m.receivedDateTime ?? "",
    snippet: m.bodyPreview ?? "",
    unread: !m.isRead,
  };
}

/**
 * Carries the HTTP status Graph answered with, so the plugin's auth-error
 * classifier can read it instead of hunting for digits in the message
 * (#1077). Graph stamps a GUID request-id into every error body, and roughly
 * one in seventy of those contains "401" by chance — which the old substring
 * matcher read as an expired token.
 */
export class GraphRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GraphRequestError";
    this.status = status;
  }
}

export class GraphAdapter implements EmailAdapter {
  constructor(private opts: { accessToken: string }) {}

  // GRAPH_API_BASE_URL allows E2E tests to redirect Graph API calls to a
  // local mock server instead of https://graph.microsoft.com. Only takes
  // effect alongside PINCHY_INSECURE_MAIL_MOCK=1 — see
  // resolveInsecureMockBaseUrl in email-adapter.ts.
  private graphBase(): string {
    return (
      resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK") ??
      "https://graph.microsoft.com"
    );
  }

  // `signal` is deliberately not accepted. The earlier shape took one and did
  // `init.signal ?? AbortSignal.timeout(...)`, which reads like a harmless
  // escape hatch and is a trap: the first caller to pass a cancellation signal
  // would silently lose the timeout, with no test able to see it. A caller
  // that needs a different bound asks for one by name instead.
  private async req(
    path: string,
    init?: Omit<RequestInit, "signal"> & { timeoutMs?: number }
  ): Promise<Response> {
    const { timeoutMs = FETCH_TIMEOUT_MS, ...rest } = init ?? {};
    const res = await fetch(`${this.graphBase()}/v1.0${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new GraphRequestError(`Graph ${res.status}: ${txt || res.statusText}`, res.status);
    }
    return res;
  }

  async list(opts: ListOptions): Promise<EmailSummary[]> {
    const limit = opts.limit ?? 20;
    // folder defaults to INBOX when omitted, matching the email_list tool
    // schema and SKILL.md documentation — without this, an omitted folder
    // queried the whole mailbox instead of the documented default.
    const folder = opts.folder ?? "INBOX";
    const path = `/me/mailFolders/${mapFolder(folder)}/messages`;
    const parts: string[] = [
      `$top=${encodeURIComponent(String(limit))}`,
      `$select=${encodeURIComponent(SUMMARY_SELECT)}`,
      `$orderby=${encodeURIComponent("receivedDateTime desc")}`,
    ];
    const filter = buildOrderedFilter(opts.unreadOnly ? ["isRead eq false"] : []);
    if (filter) parts.push(`$filter=${encodeURIComponent(filter)}`);
    const res = await this.req(`${path}?${parts.join("&")}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value.map(toSummary);
  }

  async read(id: string): Promise<EmailFull> {
    const params = new URLSearchParams({
      $select:
        "id,subject,bodyPreview,receivedDateTime,from,toRecipients,ccRecipients,isRead,body,hasAttachments",
    });
    const res = await this.req(`/me/messages/${encodeURIComponent(id)}?${params.toString()}`);
    const m = (await res.json()) as GraphMessage & {
      ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
      body?: { contentType?: string; content?: string };
      hasAttachments?: boolean;
    };
    return {
      ...toSummary(m),
      cc: m.ccRecipients?.map((r) => r.emailAddress?.address ?? "").join(", ") ?? "",
      body: extractBody(m.body),
      // Only pay for the second round trip when the message actually has
      // attachments — the common no-attachment case stays a single request.
      attachments: m.hasAttachments ? await this.listAttachments(id) : [],
    };
  }

  private async listAttachments(messageId: string): Promise<EmailAttachment[]> {
    const params = new URLSearchParams({
      $select: "id,name,contentType,size,isInline",
    });
    const res = await this.req(
      `/me/messages/${encodeURIComponent(messageId)}/attachments?${params.toString()}`
    );
    const data = (await res.json()) as { value: GraphAttachment[] };
    return data.value
      .filter((a) => !a.isInline && a["@odata.type"] === FILE_ATTACHMENT_TYPE)
      .map((a) => ({
        id: a.id,
        filename: a.name ?? "",
        mimeType: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
      }));
  }

  async getAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<{ filename: string; mimeType: string; data: Buffer }> {
    const res = await this.req(
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { timeoutMs: ATTACHMENT_TIMEOUT_MS }
    );

    // Precheck against Content-Length BEFORE res.json() buffers the whole
    // body — see MAX_ATTACHMENT_RESPONSE_BYTES above. Best-effort only: a
    // missing/absent header (chunked transfer, or a provider that omits it)
    // falls straight through to res.json(), same as before this check
    // existed — index.ts's post-decode length check is what protects the
    // process in that case.
    const declaredLength = res.headers?.get("content-length");
    if (declaredLength != null) {
      const declaredBytes = Number(declaredLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ATTACHMENT_RESPONSE_BYTES) {
        // Never read the body we just proved is too large — cancel/drain it
        // instead of letting it sit un-consumed on the connection.
        await res.body?.cancel?.();
        const declaredMb = (declaredBytes / 1024 / 1024).toFixed(1);
        const maxMb = (MAX_ATTACHMENT_RESPONSE_BYTES / 1024 / 1024).toFixed(0);
        throw new Error(
          `Attachment response too large: ${declaredMb} MB, max allowed is ${maxMb} MB.`
        );
      }
    }

    const a = (await res.json()) as GraphAttachment;
    if (a.contentBytes == null) {
      throw new Error(
        `attachment ${attachmentId} is an embedded item (e.g. an attached email or a cloud reference) ` +
          `and cannot be downloaded as a file.`
      );
    }
    // Graph fileAttachment.contentBytes is standard base64 (not base64url).
    const data = Buffer.from(a.contentBytes, "base64");
    return {
      filename: a.name ?? "",
      mimeType: a.contentType ?? "application/octet-stream",
      data,
    };
  }

  async search(opts: SearchOptions): Promise<EmailSummary[]> {
    if (opts.text) return this.searchFreeText(opts);

    // receivedDateTime is pushed first (when present) so it always leads the
    // final $filter — required by buildOrderedFilter's Graph $orderby rule.
    const filters: string[] = [];
    const searchTerms: string[] = [];
    if (opts.from) searchTerms.push(kqlTerm("from", opts.from));
    if (opts.to) searchTerms.push(kqlTerm("to", opts.to));
    if (opts.subject) searchTerms.push(kqlTerm("subject", opts.subject));
    if (opts.sinceDays != null) {
      const cutoff = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString();
      filters.push(`receivedDateTime ge ${cutoff}`);
    }
    if (opts.unread) filters.push("isRead eq false");
    if (searchTerms.length === 0 && filters.length === 0) {
      throw new Error("search requires at least one filter field");
    }
    const path = opts.folder
      ? `/me/mailFolders/${mapFolder(opts.folder)}/messages`
      : `/me/messages`;
    const params = new URLSearchParams({
      $top: String(opts.limit ?? 20),
      $select: SUMMARY_SELECT,
    });

    if (searchTerms.length > 0 && filters.length > 0) {
      // Microsoft Graph v1.0 does not allow $search and $filter together.
      // Convert text terms to OData $filter predicates instead.
      if (opts.from) filters.push(`from/emailAddress/address eq '${odataString(opts.from)}'`);
      if (opts.to)
        filters.push(`toRecipients/any(r: r/emailAddress/address eq '${odataString(opts.to)}')`);
      if (opts.subject) filters.push(`contains(subject, '${odataString(opts.subject)}')`);
      params.set("$filter", buildOrderedFilter(filters)!);
      params.set("$orderby", "receivedDateTime desc");
    } else if (searchTerms.length > 0) {
      // Only text terms — use $search (note: $orderby is not allowed with $search)
      params.set("$search", `"${searchTerms.join(" ")}"`);
    } else {
      // Only OData filters — use $filter
      params.set("$filter", buildOrderedFilter(filters)!);
      params.set("$orderby", "receivedDateTime desc");
    }

    const res = await this.req(`${path}?${params.toString()}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value.map(toSummary);
  }

  /**
   * Free-text search path (opts.text is set). Free text is inexpressible in
   * OData $filter — there is no full-text operator — so this MUST use
   * $search, built from the bare text term plus any from/to/subject terms.
   * Microsoft Graph v1.0 forbids combining $search with $filter, and forbids
   * $orderby with $search, so `unread` and `sinceDays` cannot be pushed into
   * a server-side $filter here the way the non-text path does. Instead they
   * are applied as CLIENT-SIDE post-filters on the page of results $search
   * returns. This is best-effort, not exact: Graph can't combine full-text
   * with structural filters server-side, and because $search has no
   * $orderby, results are relevance-ranked (not date-sorted) within $top —
   * an old but relevant message could be excluded from the fetched page
   * before the client-side date filter ever sees it. folder and limit are
   * unaffected: folder still scopes the path, and limit still caps $top.
   */
  private async searchFreeText(opts: SearchOptions): Promise<EmailSummary[]> {
    const searchTerms: string[] = [kqlBareTerm(opts.text!)];
    if (opts.from) searchTerms.push(kqlTerm("from", opts.from));
    if (opts.to) searchTerms.push(kqlTerm("to", opts.to));
    if (opts.subject) searchTerms.push(kqlTerm("subject", opts.subject));

    const path = opts.folder
      ? `/me/mailFolders/${mapFolder(opts.folder)}/messages`
      : `/me/messages`;
    const params = new URLSearchParams({
      $top: String(opts.limit ?? 20),
      $select: SUMMARY_SELECT,
      $search: `"${searchTerms.join(" ")}"`,
    });

    const res = await this.req(`${path}?${params.toString()}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    let summaries = data.value.map(toSummary);

    if (opts.unread) {
      summaries = summaries.filter((m) => m.unread);
    }
    if (opts.sinceDays != null) {
      const cutoff = Date.now() - opts.sinceDays * 86_400_000;
      summaries = summaries.filter((m) => {
        const received = Date.parse(m.date);
        return !Number.isNaN(received) && received >= cutoff;
      });
    }
    return summaries;
  }

  async draft(opts: ComposeOptions): Promise<{ draftId: string }> {
    if (opts.replyTo) {
      const reply = await this.req(`/me/messages/${encodeURIComponent(opts.replyTo)}/createReply`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const created = (await reply.json()) as { id: string };
      await this.req(`/me/messages/${encodeURIComponent(created.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          subject: opts.subject,
          body: { contentType: "text", content: opts.body },
          toRecipients: [{ emailAddress: { address: opts.to } }],
        }),
      });
      return { draftId: created.id };
    }
    const res = await this.req(`/me/messages`, {
      method: "POST",
      body: JSON.stringify({
        subject: opts.subject,
        body: { contentType: "text", content: opts.body },
        toRecipients: [{ emailAddress: { address: opts.to } }],
      }),
    });
    const created = (await res.json()) as { id: string };
    return { draftId: created.id };
  }

  async send(opts: ComposeOptions): Promise<{ messageId: string | null }> {
    if (opts.replyTo) {
      const { draftId } = await this.draft(opts);
      await this.req(`/me/messages/${encodeURIComponent(draftId)}/send`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return { messageId: draftId };
    }
    // Microsoft Graph's POST /me/sendMail answers 202 Accepted with an empty
    // body and NO Location header — there is no id to recover for a direct
    // send. Report messageId: null rather than fabricating one.
    await this.req(`/me/sendMail`, {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject: opts.subject,
          body: { contentType: "text", content: opts.body },
          toRecipients: [{ emailAddress: { address: opts.to } }],
        },
        saveToSentItems: true,
      }),
    });
    return { messageId: null };
  }
}

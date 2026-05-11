import type {
  EmailAdapter,
  Folder,
  ListOptions,
  SearchOptions,
  ComposeOptions,
  EmailSummary,
  EmailFull,
} from "./email-adapter.js";

const FOLDER_TO_GRAPH: Record<Folder, string> = {
  INBOX: "inbox",
  SENT: "sentitems",
  DRAFTS: "drafts",
  TRASH: "deleteditems",
  SPAM: "junkemail",
};

const SUMMARY_SELECT =
  "id,subject,bodyPreview,receivedDateTime,from,toRecipients,isRead";

function mapFolder(f: Folder): string {
  const g = FOLDER_TO_GRAPH[f];
  if (!g) throw new Error(`unknown folder: ${f}. Valid: INBOX, SENT, DRAFTS, TRASH, SPAM.`);
  return g;
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

export class GraphAdapter implements EmailAdapter {
  constructor(private opts: { accessToken: string }) {}

  private graphBase(): string {
    return process.env.GRAPH_API_BASE_URL ?? "https://graph.microsoft.com";
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.graphBase()}/v1.0${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Graph ${res.status}: ${txt || res.statusText}`);
    }
    return res;
  }

  async list(opts: ListOptions): Promise<EmailSummary[]> {
    const limit = opts.limit ?? 20;
    const path = opts.folder
      ? `/me/mailFolders/${mapFolder(opts.folder)}/messages`
      : `/me/messages`;
    const parts: string[] = [
      `$top=${encodeURIComponent(String(limit))}`,
      `$select=${encodeURIComponent(SUMMARY_SELECT)}`,
      `$orderby=${encodeURIComponent("receivedDateTime desc")}`,
    ];
    if (opts.unreadOnly) parts.push(`$filter=${encodeURIComponent("isRead eq false")}`);
    const res = await this.req(`${path}?${parts.join("&")}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value.map(toSummary);
  }

  async read(id: string): Promise<EmailFull> {
    const params = new URLSearchParams({
      $select:
        "id,subject,bodyPreview,receivedDateTime,from,toRecipients,ccRecipients,isRead,body",
    });
    const res = await this.req(
      `/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
    );
    const m = (await res.json()) as GraphMessage & {
      ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
      body?: { contentType?: string; content?: string };
    };
    return {
      ...toSummary(m),
      cc: m.ccRecipients?.map((r) => r.emailAddress?.address ?? "").join(", ") ?? "",
      body: m.body?.content ?? "",
    };
  }

  async search(opts: SearchOptions): Promise<EmailSummary[]> {
    const filters: string[] = [];
    const searchTerms: string[] = [];
    if (opts.from) searchTerms.push(`from:${opts.from}`);
    if (opts.to) searchTerms.push(`to:${opts.to}`);
    if (opts.subject) searchTerms.push(`subject:${opts.subject}`);
    if (opts.unread) filters.push("isRead eq false");
    if (opts.sinceDays != null) {
      const cutoff = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString();
      filters.push(`receivedDateTime ge ${cutoff}`);
    }
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
      if (opts.from) filters.push(`from/emailAddress/address eq '${opts.from}'`);
      if (opts.to) filters.push(`toRecipients/any(r: r/emailAddress/address eq '${opts.to}')`);
      if (opts.subject) filters.push(`contains(subject, '${opts.subject}')`);
      params.set("$filter", filters.join(" and "));
      params.set("$orderby", "receivedDateTime desc");
    } else if (searchTerms.length > 0) {
      // Only text terms — use $search (note: $orderby is not allowed with $search)
      params.set("$search", `"${searchTerms.join(" ")}"`);
    } else {
      // Only OData filters — use $filter
      params.set("$filter", filters.join(" and "));
      params.set("$orderby", "receivedDateTime desc");
    }

    const res = await this.req(`${path}?${params.toString()}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value.map(toSummary);
  }

  async draft(opts: ComposeOptions): Promise<{ draftId: string }> {
    if (opts.replyTo) {
      const reply = await this.req(
        `/me/messages/${encodeURIComponent(opts.replyTo)}/createReply`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
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

  async send(opts: ComposeOptions): Promise<{ messageId: string }> {
    if (opts.replyTo) {
      const { draftId } = await this.draft(opts);
      await this.req(`/me/messages/${encodeURIComponent(draftId)}/send`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return { messageId: draftId };
    }
    const res = await this.req(`/me/sendMail`, {
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
    const loc = res.headers.get("location") ?? "";
    return { messageId: loc.split("/").pop() ?? "" };
  }
}

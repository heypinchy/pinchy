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

  async search(_opts: SearchOptions): Promise<EmailSummary[]> {
    throw new Error("not yet implemented");
  }

  async draft(_opts: ComposeOptions): Promise<{ draftId: string }> {
    throw new Error("not yet implemented");
  }

  async send(_opts: ComposeOptions): Promise<{ messageId: string }> {
    throw new Error("not yet implemented");
  }
}

import type { EmailListItem, EmailPort, EmailReadResult } from "@/lib/email-workflows/lister";

/**
 * The Microsoft Graph (Microsoft 365) mailbox port for the reconciliation sweep.
 *
 * Runs Pinchy-side from decrypted stored credentials, with no agent session —
 * the sweep is deterministic orchestration, not an agent turn. Stateless HTTP,
 * so it implements no `close()`.
 */

const DEFAULT_FOLDER = "inbox";

/**
 * Graph's DEFAULT message ids are NOT stable: they change when a message moves
 * between folders. The ledger's claim key is
 * `(workflowId, connectionId, providerMessageId)`, so an unstable id means a
 * filed-away mail reappears under a new id, misses the ledger, and is processed
 * twice. Asking for immutable ids is what makes the claim key durable.
 *
 * This must stay CONSISTENT for the lifetime of the ledger: ids minted in
 * immutable mode are not interchangeable with default-mode ids, so removing this
 * header would invalidate every id already stored at once and re-dispatch a
 * whole window as "new". A test guards it for exactly that reason.
 */
const IMMUTABLE_ID_HEADER = { Prefer: 'IdType="ImmutableId"' } as const;

/** Same convention as probe.ts and the pinchy-email plugin's graph adapter. */
function graphBase(): string {
  return process.env.GRAPH_API_BASE_URL ?? "https://graph.microsoft.com";
}

interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

interface GraphAttachment {
  id?: string;
  name?: string | null;
  contentType?: string | null;
  isInline?: boolean;
}

export interface GraphMessage {
  id: string;
  subject?: string | null;
  receivedDateTime?: string | null;
  internetMessageId?: string | null;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  attachments?: GraphAttachment[];
}

/** Bare, comma-joined addresses — the shape the lister's address split expects. */
function formatAddresses(list?: GraphAddress[]): string {
  return (list ?? [])
    .map((r) => r.emailAddress?.address?.trim() ?? "")
    .filter((a) => a.length > 0)
    .join(", ");
}

/** Graph's message shape → the lister's raw-shaped {@link EmailReadResult}. */
export function mapGraphMessage(input: { folder: string; message: GraphMessage }): EmailReadResult {
  const { folder, message } = input;
  return {
    id: message.id,
    from: message.from?.emailAddress?.address?.trim() ?? "",
    to: formatAddresses(message.toRecipients),
    cc: formatAddresses(message.ccRecipients),
    subject: message.subject ?? "",
    date: message.receivedDateTime ?? "",
    // The requested folder, not Graph's opaque parentFolderId: the workflow's
    // filter re-checks `folder` by name, and the listing is scoped to this
    // folder by construction.
    folder,
    messageIdHeader: message.internetMessageId ?? undefined,
    attachments: (message.attachments ?? [])
      // An inline part is the HTML body's own embedded image; counting it would
      // fire every workflow's hasAttachment filter on ordinary newsletters.
      .filter((a) => !a.isInline)
      .map((a) => ({
        mimeType: a.contentType ?? "application/octet-stream",
        filename: a.name ?? undefined,
      })),
  };
}

/** Build an {@link EmailPort} over Microsoft Graph from decrypted credentials. */
export function createGraphPort(credentials: unknown): EmailPort {
  const creds = credentials as { accessToken?: unknown };
  if (typeof creds?.accessToken !== "string" || creds.accessToken.length === 0) {
    // Validate at the edge (mirroring probe.ts) so a mis-typed connection fails
    // loudly here instead of as an opaque 401 later.
    throw new Error("Graph port: stored credentials carry no access token");
  }
  const accessToken = creds.accessToken;

  async function graphGet<T>(path: string): Promise<T> {
    const res = await fetch(`${graphBase()}/v1.0${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...IMMUTABLE_ID_HEADER,
      },
    });
    if (!res.ok) {
      // Never answer a failed call as an empty mailbox: that would read as
      // "nothing new" and silently retire the workflow while its status stayed
      // `active`. Let it reach the sweep's unit-level catch instead.
      const body = await res.text().catch(() => "");
      throw new Error(`Graph port: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  return {
    async search(opts): Promise<EmailListItem[]> {
      const folder = opts.folder ?? DEFAULT_FOLDER;
      // Built with encodeURIComponent rather than URLSearchParams, mirroring the
      // pinchy-email plugin's adapter: URLSearchParams encodes a space as `+`,
      // and `%20` is the unambiguous form for OData expressions.
      const parts = [
        `$select=${encodeURIComponent("id")}`,
        // Newest first, so a bounded page keeps the most recent mail.
        `$orderby=${encodeURIComponent("receivedDateTime desc")}`,
      ];
      if (opts.limit) parts.push(`$top=${encodeURIComponent(String(opts.limit))}`);
      if (opts.sinceDays) {
        const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60_000).toISOString();
        // Graph requires the first $orderby property to lead the $filter, in the
        // same order — the pinchy-email plugin's adapter hit this too. Ordering
        // by receivedDateTime means the receivedDateTime predicate must come first.
        parts.push(`$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`);
      }
      const listed = await graphGet<{ value?: { id: string }[] }>(
        `/me/mailFolders/${encodeURIComponent(folder)}/messages?${parts.join("&")}`
      );
      return (listed.value ?? []).map((m) => ({ id: m.id }));
    },

    async read(id): Promise<EmailReadResult> {
      const parts = [
        `$select=${encodeURIComponent(
          "id,subject,receivedDateTime,internetMessageId,from,toRecipients,ccRecipients"
        )}`,
        // Expand attachments in the same round trip, but $select inside the
        // expand so Graph does not ship every attachment's contentBytes with it.
        `$expand=${encodeURIComponent("attachments($select=id,name,contentType,isInline)")}`,
      ];
      const message = await graphGet<GraphMessage>(
        `/me/messages/${encodeURIComponent(id)}?${parts.join("&")}`
      );
      return mapGraphMessage({ folder: DEFAULT_FOLDER, message });
    },
  };
}

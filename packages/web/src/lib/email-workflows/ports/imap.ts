import { ImapFlow } from "imapflow";
import type { MessageAddressObject, MessageEnvelopeObject, MessageStructureObject } from "imapflow";

import { tlsModeForPort } from "@/lib/integrations/imap-probe";
import { imapTestSchema } from "@/lib/schemas/imap";
import type { EmailListItem, EmailPort, EmailReadResult } from "@/lib/email-workflows/lister";

/**
 * The IMAP mailbox port for the Inbox Agent's reconciliation sweep.
 *
 * Unlike the `pinchy-email` plugin's adapters (which serve an agent's tools),
 * this runs Pinchy-side with no agent session, from decrypted stored
 * credentials — the sweep is deterministic orchestration, not an agent turn.
 * The web app deliberately never imports the plugin's adapters (see lister.ts).
 *
 * Connection lifecycle: the lister does 1×search + N×read, so the port opens
 * ONE connection lazily and serves everything over it, and the sweep closes it
 * in a `finally`. A connection per message is not an option.
 */

const DEFAULT_FOLDER = "INBOX";

/** Bound the sweep's IMAP I/O; a firewalled host must not stall the cadence. */
const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;

/** Bare, comma-joined addresses — the shape the lister's address split expects.
 *
 * Display names are dropped on purpose: `normalizeAddress` discards them anyway,
 * and re-emitting them would mean quoting every name containing a comma just to
 * survive the round trip through the lister's splitter. */
function formatAddressList(list?: MessageAddressObject[]): string {
  return (list ?? [])
    .map((a) => a.address?.trim() ?? "")
    .filter((a) => a.length > 0)
    .join(", ");
}

/**
 * Walk a BODYSTRUCTURE tree and collect the parts a human would call an
 * attachment. Only `disposition: "attachment"` counts — an `inline` part is the
 * HTML body's own image, and treating it as an attachment would fire every
 * workflow's `hasAttachment` filter on ordinary newsletters.
 */
export function collectAttachments(
  node?: MessageStructureObject
): { mimeType: string; filename?: string }[] {
  const found: { mimeType: string; filename?: string }[] = [];
  const walk = (n?: MessageStructureObject): void => {
    if (!n) return;
    if (n.disposition?.toLowerCase() === "attachment") {
      found.push({
        mimeType: n.type,
        // Content-Disposition's filename is the RFC 6266 home; the Content-Type
        // `name` parameter is the legacy fallback older senders still use.
        filename: n.dispositionParameters?.filename ?? n.parameters?.name,
      });
    }
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return found;
}

/** imapflow's parsed message → the lister's raw-shaped {@link EmailReadResult}. */
export function mapImapMessage(input: {
  uid: number;
  folder: string;
  envelope?: MessageEnvelopeObject;
  bodyStructure?: MessageStructureObject;
  internalDate?: Date;
}): EmailReadResult {
  const { uid, folder, envelope, bodyStructure, internalDate } = input;
  // A message with no Date header still has an IMAP INTERNALDATE. Without this
  // fallback the lister would reject it as unparseable and its poison-message
  // isolation would silently drop a real email.
  const date = envelope?.date ?? internalDate;
  return {
    id: String(uid),
    from: formatAddressList(envelope?.from),
    to: formatAddressList(envelope?.to),
    cc: formatAddressList(envelope?.cc),
    subject: envelope?.subject ?? "",
    date: date ? date.toISOString() : "",
    folder,
    messageIdHeader: envelope?.messageId,
    attachments: collectAttachments(bodyStructure),
  };
}

/**
 * Build an {@link EmailPort} over IMAP from a connection's decrypted credentials.
 *
 * Credentials are validated at this edge (mirroring probe.ts): a connection
 * whose stored blob does not match the IMAP shape fails loudly here rather than
 * as an opaque runtime error deep inside imapflow.
 */
export function createImapPort(credentials: unknown): EmailPort {
  const parsed = imapTestSchema.safeParse(credentials);
  if (!parsed.success) {
    throw new Error("IMAP port: stored credentials do not match the IMAP shape");
  }
  const creds = parsed.data;

  let client: ImapFlow | null = null;
  let openFolder: string | null = null;

  /** Connect once, then select the folder only when it actually changes. */
  async function open(folder: string): Promise<ImapFlow> {
    if (!client) {
      client = new ImapFlow({
        host: creds.imapHost,
        port: creds.imapPort,
        secure: tlsModeForPort(creds.imapPort, creds.security).secure,
        auth: { user: creds.username, pass: creds.password },
        logger: false,
        connectionTimeout: CONNECT_TIMEOUT_MS,
        greetingTimeout: CONNECT_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
      });
      await client.connect();
    }
    if (openFolder !== folder) {
      await client.mailboxOpen(folder);
      openFolder = folder;
    }
    return client;
  }

  return {
    async search(opts): Promise<EmailListItem[]> {
      const folder = opts.folder ?? DEFAULT_FOLDER;
      const imap = await open(folder);
      // `since` is a date, not a timestamp: IMAP SINCE has day granularity, so
      // this is a coarse pre-filter. The sweep's own `sinceTs` watermark is what
      // actually bounds the window — this only keeps us from hydrating the
      // entire mailbox.
      const since = opts.sinceDays
        ? new Date(Date.now() - opts.sinceDays * 24 * 60 * 60_000)
        : undefined;
      // imapflow answers `false` (not an empty array) when the server rejects
      // the SEARCH — treat that as "nothing listed" rather than crashing on .map.
      const uids = await imap.search({ since }, { uid: true });
      const ids = (Array.isArray(uids) ? uids : []).map((uid) => ({ id: String(uid) }));
      // Keep the NEWEST when a limit applies: UIDs ascend with arrival, so the
      // tail is the most recent mail — the half a bounded pass should look at.
      return opts.limit && ids.length > opts.limit ? ids.slice(-opts.limit) : ids;
    },

    async read(id): Promise<EmailReadResult> {
      const folder = openFolder ?? DEFAULT_FOLDER;
      const imap = await open(folder);
      const message = await imap.fetchOne(
        id,
        { envelope: true, bodyStructure: true, internalDate: true },
        { uid: true }
      );
      if (!message) {
        // Deleted or expunged between search and read. The lister isolates this
        // per message, so it costs exactly this mail.
        throw new Error(`IMAP port: message ${id} not found in ${folder}`);
      }
      return mapImapMessage({
        uid: Number(id),
        folder,
        envelope: message.envelope,
        bodyStructure: message.bodyStructure,
        // imapflow types internalDate as string | Date depending on the server's
        // response shape; normalize before the mapper's toISOString().
        internalDate: message.internalDate ? new Date(message.internalDate) : undefined,
      });
    },

    async close(): Promise<void> {
      if (!client) return;
      const closing = client;
      client = null;
      openFolder = null;
      await closing.logout();
    },
  };
}

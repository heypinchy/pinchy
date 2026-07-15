import type { DispatchableEmail } from "@/lib/email-workflows/types";

/**
 * The narrow mailbox I/O the lister needs, deliberately **decoupled** from the
 * `pinchy-email` plugin: the web app never imports the plugin's adapters. The
 * shapes match the plugin's `email_search`/`email_read` JSON structurally, so
 * Brick D can build a production port from decrypted connection credentials
 * while tests inject an in-memory fake — mirroring how `dispatchEmails` injects
 * {@link import("./dispatch").RunAgent}.
 *
 * Ids here are **raw provider ids**, never the plugin's per-agent handles: the
 * lister feeds the ledger's claim key `(workflowId, connectionId,
 * providerMessageId)`, which must be the stable provider id.
 */

/** One candidate from `search` — only its id is load-bearing; `read` is the field source. */
export interface EmailListItem {
  id: string;
}

/** A fully hydrated message from `read`, in the provider's raw (un-normalized) header shapes. */
export interface EmailReadResult {
  /** Raw provider message id — the dedup/claim key. */
  id: string;
  /** Raw `From` header: a bare address or `Display Name <addr>`. */
  from: string;
  /** Raw `To` header: may carry display names and be comma-separated. */
  to: string;
  /** Raw `Cc` header, same shape as `to`. Folded into the recipient set. */
  cc: string;
  subject: string;
  /** Provider timestamp (RFC 3339 / header date). */
  date: string;
  folder?: string;
  /** RFC 5322 `Message-ID`, when the adapter exposes it. */
  messageIdHeader?: string;
  attachments: { mimeType: string; filename?: string }[];
}

export interface EmailPort {
  search(opts: { sinceDays?: number; folder?: string; limit?: number }): Promise<EmailListItem[]>;
  read(id: string): Promise<EmailReadResult>;
}

/** Extract the bare, lower-cased address from `Display Name <addr>` or a raw `addr`. */
function normalizeAddress(raw: string): string {
  const angle = raw.lastIndexOf("<");
  const inner = angle >= 0 ? raw.slice(angle + 1, raw.indexOf(">", angle)) : raw;
  return inner.trim().toLowerCase();
}

/** Split a raw `To`/`Cc` header on commas and normalize each address, dropping blanks. */
function normalizeAddressList(raw: string): string[] {
  return raw
    .split(",")
    .map(normalizeAddress)
    .filter((a) => a.length > 0);
}

/**
 * List a connection's candidate messages and hydrate each into a
 * {@link DispatchableEmail} (design §6). The filter needs attachment metadata,
 * which only `read` returns, so every candidate is hydrated — an N+1 that is
 * fine on the bounded sweep path this serves (the token-free steady-state poll
 * lives in the OpenClaw event-trigger, a later brick).
 *
 * Normalization is the deterministic substance: providers hand back
 * inconsistent header shapes (Gmail raw `Display Name <addr>` and
 * comma-separated recipients, Graph/IMAP sometimes bare), so senders and the
 * merged To+Cc recipient set are unwrapped to bare lower-cased addresses,
 * attachment MIME types lower-cased, and the provider timestamp parsed to a
 * `Date`. Recipients are de-duplicated because a message copied to both To and
 * Cc must not surface the same address twice.
 */
export async function listDispatchableEmails(
  port: EmailPort,
  opts: { sinceDays?: number; folder?: string; limit?: number }
): Promise<DispatchableEmail[]> {
  const candidates = await port.search(opts);
  const emails: DispatchableEmail[] = [];
  for (const candidate of candidates) {
    const msg = await port.read(candidate.id);
    emails.push(normalize(msg));
  }
  return emails;
}

function normalize(msg: EmailReadResult): DispatchableEmail {
  const receivedAt = new Date(msg.date);
  if (Number.isNaN(receivedAt.getTime())) {
    throw new Error(`mail lister: unparseable date "${msg.date}" for message ${msg.id}`);
  }
  const recipients = [...normalizeAddressList(msg.to), ...normalizeAddressList(msg.cc)];
  return {
    providerMessageId: msg.id,
    messageIdHeader: msg.messageIdHeader,
    from: normalizeAddress(msg.from),
    to: [...new Set(recipients)],
    subject: msg.subject,
    folder: msg.folder,
    attachments: msg.attachments.map((a) => ({
      contentType: a.mimeType.toLowerCase(),
      filename: a.filename,
    })),
    receivedAt,
  };
}

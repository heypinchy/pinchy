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

/**
 * The lister's output. `emails` is the hydrated, usable batch; `candidateCount`
 * is how many candidates `search` returned *before* hydration dropped any.
 *
 * The two differ by the poison messages the lister isolates, and that gap is
 * exactly why the sweep's saturation check must read `candidateCount`, not
 * `emails.length`: a full page with a single unusable message hands back
 * `limit - 1` emails, so gating truncation on the hydrated count would fall
 * silent on the worst pass — one that is both truncated AND lossy.
 */
export interface EmailListResult {
  emails: DispatchableEmail[];
  candidateCount: number;
}

/** Extract the bare, lower-cased address from `Display Name <addr>` or a raw `addr`. */
function normalizeAddress(raw: string): string {
  const angle = raw.lastIndexOf("<");
  if (angle < 0) return raw.trim().toLowerCase();
  const close = raw.indexOf(">", angle);
  // A corrupt, unterminated `<addr` must not drop its last char (slice(-1)); take
  // the rest of the string instead.
  const inner = close >= 0 ? raw.slice(angle + 1, close) : raw.slice(angle + 1);
  return inner.trim().toLowerCase();
}

/**
 * Split a raw `To`/`Cc` header into its individual addresses. Separators are
 * `,` (RFC 5322) and `;` (Exchange/Graph legacy), but only outside a quoted
 * display name or an `<addr>` bracket — so `"Doe, John" <john@x>` stays one
 * address instead of shattering into a phantom `"doe` recipient.
 */
function splitAddressList(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    else if ((ch === "," || ch === ";") && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Split a raw `To`/`Cc` header and normalize each address, dropping blanks. */
function normalizeAddressList(raw: string): string[] {
  return splitAddressList(raw)
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
): Promise<EmailListResult> {
  // `search` is the mailbox-level probe: if it throws, nothing was listed and the
  // failure is the connection's, so it propagates to the sweep's unit-level catch
  // and surfaces as the workflow's `error` status.
  const candidates = await port.search(opts);
  const emails: DispatchableEmail[] = [];
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    // Isolate per message: one unusable mail (unparseable date, a read that 404s
    // on a message deleted mid-sweep) must cost exactly that mail, not the whole
    // mailbox's pass. Without this, a single corrupt message stops every other
    // message on the connection from ever being dispatched — indefinitely, since
    // the sweep re-lists the same window every cadence.
    try {
      emails.push(normalize(await port.read(candidate.id)));
    } catch (err) {
      failures.push(err);
      console.warn(`mail lister: skipping unusable message ${candidate.id}`, err);
    }
  }
  // But isolation must not swallow a dead mailbox. Credentials expiring between
  // `search` and `read` fail EVERY hydration; reported as an empty inbox that
  // would read as "nothing new" and silently retire the workflow while its status
  // stayed `active`. No usable message at all is a mailbox failure, not an outlier.
  if (failures.length > 0 && emails.length === 0) {
    throw failures[0];
  }
  // `candidateCount` is the pre-hydration count on purpose: the sweep reads it to
  // detect a truncated page, and a dropped poison message must not mask a full one.
  return { emails, candidateCount: candidates.length };
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

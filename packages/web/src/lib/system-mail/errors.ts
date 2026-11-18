import { classifyProbeError } from "@/lib/integrations/imap-probe";

/**
 * What went wrong with a send or a verify, in words an admin can act on.
 *
 * nodemailer tags an SMTP rejection with the command that drew it. A refused
 * sender is the most common real-world failure after a login that worked —
 * relays let you authenticate and then refuse to send as an address the
 * account doesn't own — so it gets its own message rather than "check your
 * settings". The message never repeats an address: it is also written to the
 * immutable audit row, where a plain email address must never go.
 */
export function classifyMailError(error: unknown): string {
  const e = (error ?? {}) as { command?: unknown; responseCode?: unknown; code?: unknown };
  if (e.responseCode === 530) {
    return "The mail server wants a login before it sends — add a username and password.";
  }
  if (e.command === "MAIL FROM") {
    return "The mail server refused the sender address — check that this account may send as it.";
  }
  if (e.command === "RCPT TO") {
    return "The mail server refused the recipient address.";
  }
  if (e.code === "ETLS") {
    return "Could not establish a secure connection — check the encryption setting";
  }
  return classifyProbeError(error).message;
}

import { resolveConnectionCredentials } from "@/lib/integrations/resolve-credentials";
import { createImapPort } from "@/lib/email-workflows/ports/imap";
import { createGraphPort } from "@/lib/email-workflows/ports/graph";
import type { EmailPort } from "@/lib/email-workflows/lister";

/**
 * The sweep's production `createPort`: turn a connectionId into a live mailbox
 * port.
 *
 * Credential resolution (decrypt + OAuth auto-refresh) is shared with the
 * internal credentials route via {@link resolveConnectionCredentials}, so the
 * sweep reaches a mailbox exactly the way the plugins do — from the same
 * decrypted stored credentials, through one tested path.
 *
 * Failures propagate: the sweep catches them at unit level and surfaces them as
 * the workflow's `error` status, which is the honest outcome for a mailbox that
 * cannot be reached (see resolve-credentials' typed errors).
 */
export async function createEmailPort(connectionId: string): Promise<EmailPort> {
  const { type, credentials } = await resolveConnectionCredentials(connectionId);

  switch (type) {
    case "imap":
      return createImapPort(credentials);
    case "microsoft":
      return createGraphPort(credentials);
    default:
      // A workflow pointed at a non-mailbox connection (odoo, web-search) is a
      // configuration bug. Fail loudly rather than hand back a port that
      // silently lists nothing forever.
      throw new Error(
        `createEmailPort: connection ${connectionId} is not a mailbox (type: ${type})`
      );
  }
}

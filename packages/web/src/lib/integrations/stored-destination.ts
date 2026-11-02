import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { assertMailHostAllowed, MailHostBlockedError } from "@/lib/integrations/mail-host-guard";

/**
 * Re-checks the destination a STORED connection points at, at the moment
 * something is about to connect to it.
 *
 * The Odoo URL and the IMAP/SMTP hosts are validated when an admin saves a
 * connection (`validateExternalUrl`, `assertMailHostAllowed`). That is a
 * check of the rules as they were then. The rules change — an upgrade
 * tightened them (100.64.0.0/10 used to read as public), or an operator
 * removes `ALLOW_PRIVATE_URLS` — and a saved URL was never looked at again: the
 * plugins, the "Test connection" button and the inbox sweep all connected to
 * whatever the database said. So the same guards run again at each place a
 * stored destination leaves Pinchy's hands:
 *
 *   - `GET /api/internal/integrations/:id/credentials` — every plugin fetch
 *   - `POST /api/integrations/:id/test` and `probeIntegrationCredentials`
 *   - `createEmailPort` — the inbox sweep's IMAP connection
 *
 * Same opt-ins as at save time, deliberately: a connection that may be saved
 * may be used, and one that may not, may not.
 *
 * What this does NOT close is DNS rebinding between this check and the
 * consumer's own connect: the plugin (or imapflow) resolves the name again.
 * Pinning the connection to the checked address would have to happen inside
 * each client library — the same caveat both guards already document.
 */

/** Which stored credential field held the refused destination. */
export type StoredDestinationField = "url" | "imapHost" | "smtpHost";

export type StoredDestinationCheck =
  { allowed: true } | { allowed: false; field: StoredDestinationField; message: string };

/**
 * Thrown where a refusal has to travel as an exception (the inbox sweep).
 * Its own class so nothing downstream mistakes it for a credentials failure:
 * the stored password may be perfectly good.
 */
export class StoredDestinationRefusedError extends Error {
  readonly field: StoredDestinationField;

  constructor(field: StoredDestinationField, guardMessage: string) {
    super(`Pinchy refuses this connection's stored ${FIELD_LABELS[field]}. ${guardMessage}`);
    this.name = "StoredDestinationRefusedError";
    this.field = field;
  }
}

const FIELD_LABELS: Record<StoredDestinationField, string> = {
  url: "server URL",
  imapHost: "IMAP host",
  smtpHost: "SMTP host",
};

/**
 * Checks the destination fields of a decrypted credential set for its
 * connection type. Types whose host is fixed by the provider (Microsoft,
 * Google, web search) have nothing stored to check.
 *
 * A field that is absent or not a string is skipped: there is no destination to
 * connect to, and the consumer's own shape check refuses that credential set.
 */
export async function checkStoredDestination(
  type: string,
  credentials: Record<string, unknown>
): Promise<StoredDestinationCheck> {
  if (type === "odoo") {
    const url = credentials.url;
    if (typeof url !== "string") return { allowed: true };
    const result = await validateExternalUrl(url);
    return result.valid
      ? { allowed: true }
      : { allowed: false, field: "url", message: result.error };
  }

  if (type === "imap") {
    // Both: the inbox sweep reads over IMAP, and the agent's send tool connects
    // to SMTP with the very same credentials.
    for (const field of ["imapHost", "smtpHost"] as const) {
      const host = credentials[field];
      if (typeof host !== "string") continue;
      try {
        await assertMailHostAllowed(host);
      } catch (err) {
        if (!(err instanceof MailHostBlockedError)) throw err;
        return { allowed: false, field, message: err.message };
      }
    }
    return { allowed: true };
  }

  return { allowed: true };
}

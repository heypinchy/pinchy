import { OdooClient } from "odoo-node";
import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { testImapLogin, testSmtpVerify, friendlyError } from "@/lib/integrations/imap-probe";
import { imapTestSchema } from "@/lib/schemas/imap";

/**
 * Verify that credentials work for the given integration type.
 *
 * On success may return `freshCredentials` — values resolved during the probe
 * that the caller should persist (e.g. Odoo's `uid` after a `login` change).
 *
 * On failure, `transient` distinguishes a genuine auth problem (bad/expired
 * credentials — the connection needs a reconnect) from a temporary provider
 * hiccup (5xx, 429, network error — the credentials are still fine, retry
 * later). Callers must not flip a connection to `auth_failed` on a transient
 * result.
 */
export type ProbeResult =
  | { success: true; freshCredentials?: Record<string, unknown> }
  | { success: false; reason: string; transient?: boolean };

export async function probeIntegrationCredentials(
  type: string,
  credentials: Record<string, unknown>
): Promise<ProbeResult> {
  if (type === "odoo") {
    const parsed = odooCredentialsSchema.safeParse(credentials);
    if (!parsed.success) return { success: false, reason: "Invalid credentials format" };

    // Re-authenticate so we (a) verify the login/apiKey actually work and
    // (b) refresh the stored uid in case the login changed. Without this
    // step, a wrong login or apiKey would surface as the opaque "Could not
    // access any Odoo models" error from the model probe below — because
    // the probe runs with a stale uid against the new key.
    let uid: number;
    try {
      uid = await OdooClient.authenticate({
        url: parsed.data.url,
        db: parsed.data.db,
        login: parsed.data.login,
        apiKey: parsed.data.apiKey,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        reason: `Authentication failed. Please verify your login and API key. (${detail})`,
      };
    }

    const result = await fetchOdooSchema({ ...parsed.data, uid });
    if (!result.success) return { success: false, reason: result.error };
    return { success: true, freshCredentials: { uid } };
  }

  if (type === "web-search") {
    const apiKey = credentials.apiKey;
    if (typeof apiKey !== "string" || !apiKey) {
      return { success: false, reason: "apiKey is required" };
    }
    return probeBraveApiKey(apiKey);
  }

  if (type === "microsoft") {
    const accessToken = credentials.accessToken;
    if (typeof accessToken !== "string" || !accessToken) {
      return { success: false, reason: "No access token stored. Please reconnect to Microsoft." };
    }
    const graphBase = process.env.GRAPH_API_BASE_URL ?? "https://graph.microsoft.com";
    try {
      const res = await fetch(`${graphBase}/v1.0/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) return { success: true };
      if (res.status === 401 || res.status === 403) {
        return {
          success: false,
          reason: "Access token expired or revoked. Please reconnect to Microsoft.",
        };
      }
      // Any other non-2xx (5xx, 429, unexpected 4xx) is a temporary provider
      // hiccup, not evidence the credentials are bad — do not report this as
      // an auth failure.
      return {
        success: false,
        transient: true,
        reason: `Microsoft Graph returned ${res.status} — temporary error, try again.`,
      };
    } catch {
      return {
        success: false,
        transient: true,
        reason: "Could not reach Microsoft. Please check your connection.",
      };
    }
  }

  if (type === "imap") {
    const parsed = imapTestSchema.safeParse(credentials);
    if (!parsed.success) return { success: false, reason: "Invalid credentials format" };

    try {
      await testImapLogin(parsed.data);
      await testSmtpVerify(parsed.data);
      return { success: true };
    } catch (err) {
      const reason = friendlyError(err);
      // Mirror the microsoft branch: an auth-shaped failure means the
      // credentials are genuinely bad and the connection should be flipped
      // to auth_failed. A connection/timeout error is a temporary network
      // hiccup — the credentials are still fine, so the caller must NOT
      // flip the connection's status on this result.
      const isTransient =
        /timed out|could not connect|secure connection/i.test(reason) &&
        !/authentication failed/i.test(reason);
      return isTransient ? { success: false, transient: true, reason } : { success: false, reason };
    }
  }

  return { success: false, reason: `Cannot probe credentials for unknown type: ${type}` };
}

import { OdooClient } from "odoo-node";
import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { testImapLogin, testSmtpVerify, friendlyError } from "@/lib/integrations/imap-probe";
import { imapTestSchema } from "@/lib/schemas/imap";
import { listMcpTools, McpAuthError } from "@/lib/integrations/mcp-client";

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

/**
 * @param data  Type-specific connection metadata (the `integration_connections.data`
 *   column). Only the mcp branch reads it (it needs `url`/`transport`/
 *   `extraHeaders`, which live outside `credentials`); every other branch
 *   ignores it. Callers pass the connection row's `data` column through
 *   unchanged — see [connectionId]/route.ts (PATCH) and
 *   [connectionId]/test/route.ts.
 */
export async function probeIntegrationCredentials(
  type: string,
  credentials: Record<string, unknown>,
  data?: Record<string, unknown> | null
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
      // Mirror the microsoft branch's fail-safe default: only an auth-shaped
      // failure is evidence the stored credentials are bad and may flip the
      // connection to auth_failed. Everything else (timeouts, connection refused,
      // TLS/cert errors, socket hang up, any unmapped error) is a transient hiccup,
      // so a healthy connection is never falsely flagged.
      const isAuthFailure = /authentication failed/i.test(reason);
      return isAuthFailure
        ? { success: false, reason }
        : { success: false, transient: true, reason };
    }
  }

  if (type === "mcp") {
    const url = data?.url;
    const transport = data?.transport;
    if (typeof url !== "string" || !url || (transport !== "http" && transport !== "sse")) {
      // This is a format problem with the stored connection, not a network
      // hiccup — reconnecting won't help until the connection itself is
      // fixed, so it must never be transient.
      return { success: false, reason: "This connection is missing its server details." };
    }
    const token = credentials.token;
    if (typeof token !== "string" || !token) {
      return { success: false, reason: "A token is required." };
    }
    const extraHeaders = data?.extraHeaders as Record<string, string> | undefined;

    try {
      await listMcpTools({ url, transport, token, extraHeaders });
      return { success: true };
    } catch (err) {
      // McpAuthError (401/403) is the only mcp failure that is real evidence
      // the stored token is bad — everything else (5xx/429 McpServerError, a
      // malformed McpSchemaError response, DNS/timeout/abort) is fail-safe
      // transient: a broken or slow server is not proof the token is wrong,
      // and a healthy connection must never be flipped to auth_failed on a
      // hiccup. Mirrors the imap/microsoft branches' fail-safe default above.
      if (err instanceof McpAuthError) {
        return {
          success: false,
          // Covers both codes McpAuthError stands for: 401 (token rejected)
          // and 403 (token fine, permissions missing) — so the message names
          // both things worth checking, like mcp-error-messages.ts does.
          reason:
            "The server rejected this token. Check that it hasn't expired and has the permissions it needs, then reconnect.",
        };
      }
      return {
        success: false,
        transient: true,
        reason: "Couldn't reach the server right now. Try again in a moment.",
      };
    }
  }

  return { success: false, reason: `Cannot probe credentials for unknown type: ${type}` };
}

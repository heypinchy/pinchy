import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { describeOdooAuthenticateFailure } from "@/lib/integrations/odoo-error";
import {
  testImapLogin,
  testSmtpVerify,
  friendlyError,
  classifyProbeError,
} from "@/lib/integrations/imap-probe";
import { imapTestSchema } from "@/lib/schemas/imap";
import { resolveInsecureMockBaseUrl } from "@/lib/integrations/insecure-mock-base-url";
import { resolveExternalUrlTarget } from "@/lib/integrations/url-validation";
import { withPinnedOdoo, type PinnedOdooFetch } from "@/lib/integrations/odoo-pin";
import { authenticateOdoo } from "@/lib/integrations/odoo-calls";
import { listMcpTools, McpAuthError } from "@/lib/integrations/mcp-client";

/**
 * Verify that credentials work for the given integration type.
 *
 * On success may return `freshCredentials` — values resolved during the probe
 * that the caller should persist (e.g. Odoo's `uid` after a `login` change).
 *
 * On failure, `transient: true` means "this failure is not evidence against
 * the credentials": callers must not flip the connection to `auth_failed`,
 * because re-entering the login or key would not fix it. Despite the name,
 * not every such failure goes away on retry. It covers a provider hiccup
 * (5xx, 429, network error), a destination the SSRF guard refuses, an Odoo
 * URL that never gave an Odoo answer (a redirect, a proxy error, a network
 * failure, a non-JSON-RPC body; see `isOdooAuthFailure`), and — for Odoo — a
 * login that worked followed by a schema probe that failed for any reason but
 * an access denial, including an Odoo user without read access to any synced
 * model. `reason` says which. Without `transient`, the credentials themselves
 * were refused and the connection needs a reconnect.
 */
export type ProbeResult =
  | { success: true; freshCredentials?: Record<string, unknown> }
  | { success: false; reason: string; transient?: boolean };

export async function probeIntegrationCredentials(
  type: string,
  credentials: Record<string, unknown>,
  options: {
    /**
     * A fetch the caller already pinned to this Odoo URL's checked addresses
     * (`withPinnedOdoo`). The probe then neither looks the host up again nor
     * opens a scope of its own; a request to any other origin is refused.
     */
    odooFetch?: PinnedOdooFetch;
    /**
     * Type-specific connection metadata (the `integration_connections.data`
     * column). Only the mcp branch reads it (it needs `url`/`transport`/
     * `extraHeaders`, which live outside `credentials`); every other branch
     * ignores it. Callers pass the connection row's `data` column through
     * unchanged — see [connectionId]/route.ts (PATCH) and
     * [connectionId]/test/route.ts.
     */
    data?: Record<string, unknown> | null;
  } = {}
): Promise<ProbeResult> {
  if (type === "odoo") {
    const parsed = odooCredentialsSchema.safeParse(credentials);
    if (!parsed.success) return { success: false, reason: "Invalid credentials format" };

    // The URL may come from the database rather than the request (a PATCH
    // that only changes the API key merges it with the stored URL), so it is
    // checked here, before authenticate sends the key to it. The imap branch
    // gets the same from testImapLogin/testSmtpVerify, which run the guard.
    // Resolved once: the answer that is classified here is the address every
    // call below connects to, instead of a second lookup by name.
    // A caller that already checked and pinned it (the connection test route)
    // hands its fetch in, and the host is not looked up a second time.
    if (options.odooFetch) return probeOdoo(parsed.data, options.odooFetch);
    const destination = await resolveExternalUrlTarget(parsed.data.url);
    if (!destination.valid) {
      return { success: false, transient: true, reason: destination.error };
    }
    return withPinnedOdoo(destination.url, destination.target, (pinned) =>
      probeOdoo(parsed.data, pinned)
    );
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
    // Honoured only alongside PINCHY_INSECURE_MAIL_MOCK=1 — this probe sends
    // the stored access token. See insecure-mock-base-url.ts.
    const graphBase =
      resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL") ?? "https://graph.microsoft.com";
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
      // Uses the shared per-leg classifier (also used by the "Test & Save"
      // route) rather than re-matching friendlyError's wording, so the two
      // callers can never classify the same error differently.
      const isAuthFailure = classifyProbeError(err).code === "auth";
      return isAuthFailure
        ? { success: false, reason }
        : { success: false, transient: true, reason };
    }
  }

  if (type === "mcp") {
    const data = options.data;
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

type OdooCredentials = NonNullable<ReturnType<typeof odooCredentialsSchema.safeParse>["data"]>;

/** The Odoo probe proper. Every request goes through `pinned`. */
async function probeOdoo(
  parsedData: OdooCredentials,
  pinned: PinnedOdooFetch
): Promise<ProbeResult> {
  // Re-authenticate so we (a) verify the login/apiKey actually work and
  // (b) refresh the stored uid in case the login changed. Without this
  // step, a wrong login or apiKey would surface as the opaque "Could not
  // access any Odoo models" error from the model probe below — because
  // the probe runs with a stale uid against the new key.
  let uid: number;
  try {
    uid = await authenticateOdoo({
      url: parsedData.url,
      db: parsedData.db,
      login: parsedData.login,
      apiKey: parsedData.apiKey,
      fetch: pinned,
    });
  } catch (err) {
    return describeOdooAuthenticateFailure(err);
  }

  const result = await fetchOdooSchema({ ...parsedData, uid, fetch: pinned });
  // Only an access denial says something about these credentials; any other
  // schema failure (every model refused alike by a proxy, Odoo unreachable)
  // must not flag the connection auth_failed.
  if (!result.success) {
    return { success: false, reason: result.error, transient: !result.isAuthError };
  }
  return { success: true, freshCredentials: { uid } };
}

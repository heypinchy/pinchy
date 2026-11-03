// audit-exempt: audit writes happen indirectly via setIntegrationAuthFailed (integration.auth_failed)
// and clearIntegrationAuthError (integration.auth_recovered) on status transitions. The Odoo uid
// self-heal path intentionally writes no audit entry — it is a one-time bootstrap, not a
// user-initiated change. A refused stored destination changes no state either: it is answered
// to the admin who clicked, and nothing is written.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { OdooClient } from "odoo-node";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import {
  describeOdooAuthenticateFailure,
  describeOdooError,
  isOdooAuthFailure,
} from "@/lib/integrations/odoo-error";
import { probeIntegrationCredentials } from "@/lib/integrations/probe";
import { checkStoredDestination } from "@/lib/integrations/stored-destination";
import { clearIntegrationAuthError, setIntegrationAuthFailed } from "@/lib/integrations/auth-state";
import { isTokenExpired } from "@/lib/integrations/oauth-token";
import {
  refreshMicrosoftCredentials,
  OAuthSettingsMissingError,
  type MicrosoftCredentials,
} from "@/lib/integrations/microsoft-refresh";

type RouteContext = { params: Promise<{ connectionId: string }> };

export const POST = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { connectionId } = await params;
  const actor = { type: "user" as const, id: session.user.id! };

  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  try {
    let decrypted = JSON.parse(decrypt(connection.credentials));

    // The stored Odoo URL / IMAP / SMTP host was validated when it was saved,
    // not since — and both the self-heal below and the probe connect to it.
    // A refusal is a configuration problem, not evidence the credentials are
    // bad, so it is answered without touching the auth state: flagging
    // auth_failed would send the admin to re-enter a perfectly good key.
    const destination = await checkStoredDestination(connection.type, decrypted);
    if (!destination.allowed) {
      return NextResponse.json({ success: false, error: destination.message }, { status: 200 });
    }

    // Odoo uid self-heal: if the authenticate call returns a different uid than
    // what is stored (e.g. first connection with a placeholder), update the stored
    // credentials. This must happen before the probe so the probe uses the correct uid.
    if (connection.type === "odoo") {
      const parsed = odooCredentialsSchema.safeParse(decrypted);
      if (parsed.success) {
        const creds = parsed.data;
        let uid: number;
        try {
          uid = await OdooClient.authenticate({
            url: creds.url,
            db: creds.db,
            login: creds.login,
            apiKey: creds.apiKey,
          });
        } catch (err) {
          // Odoo refusing the login: re-thrown with a message fit for the
          // admin, which the catch below shows and records as the auth-failure
          // reason. Anything else — a redirect, a proxy error, a non-JSON-RPC
          // answer — says nothing about the credentials: report it the way the
          // probe does and leave the status alone. Neither quotes a response
          // body. See odoo-error.ts.
          if (isOdooAuthFailure(err)) throw new Error(describeOdooError(err));
          const { reason } = describeOdooAuthenticateFailure(err);
          return NextResponse.json({ success: false, error: reason }, { status: 200 });
        }
        if (uid !== creds.uid) {
          decrypted.uid = uid;
          await db
            .update(integrationConnections)
            .set({
              credentials: encrypt(JSON.stringify({ ...creds, uid })),
              updatedAt: new Date(),
            })
            .where(eq(integrationConnections.id, connectionId));
        }
      }
    }

    // Microsoft token pre-refresh: an idle mailbox connection can have a
    // long-expired access token while its refresh token is still valid. The
    // internal credentials route (used by the plugin) transparently refreshes
    // in that case, but "Test Connection" bypasses that route and probes
    // Graph directly with the stored token — without this refresh, the probe
    // would 401 on a perfectly healthy connection and falsely flip it to
    // auth_failed. Mirrors the Odoo self-heal above: must happen before the
    // probe so the probe uses live credentials.
    if (connection.type === "microsoft") {
      const current = decrypted as MicrosoftCredentials;
      if (current.expiresAt && isTokenExpired(current.expiresAt)) {
        try {
          decrypted = await refreshMicrosoftCredentials(connectionId, current);
        } catch (err) {
          if (err instanceof OAuthSettingsMissingError) {
            // No credential to fall back to that will actually work — the
            // connection is genuinely unusable until the OAuth app is
            // restored, so this IS a real auth_failed, not a transient blip.
            const reason =
              "Microsoft OAuth app is not configured — reconnect after restoring the OAuth app settings";
            await setIntegrationAuthFailed({ connectionId, reason, actor });
            return NextResponse.json({ success: false, error: reason }, { status: 200 });
          }
          throw err;
        }
      }
    }

    const probe = await probeIntegrationCredentials(connection.type, decrypted);

    if (probe.success) {
      await clearIntegrationAuthError({ connectionId, actor });
      return NextResponse.json({ success: true });
    } else if (probe.transient) {
      // A transient provider hiccup is not evidence the credentials are
      // bad — report the failure to the client but leave the connection's
      // status untouched so it isn't falsely flagged auth_failed.
      return NextResponse.json({ success: false, error: probe.reason }, { status: 200 });
    } else {
      await setIntegrationAuthFailed({ connectionId, reason: probe.reason, actor });
      return NextResponse.json({ success: false, error: probe.reason }, { status: 200 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    await setIntegrationAuthFailed({ connectionId, reason: message, actor });
    return NextResponse.json({ success: false, error: message }, { status: 200 });
  }
});

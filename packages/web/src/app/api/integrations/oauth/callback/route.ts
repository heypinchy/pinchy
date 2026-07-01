// auth-direct: browser-flow callback. The user has just bounced through
// Google's or Microsoft's OAuth consent screen; on auth failure we render a
// redirect to /settings, not a JSON 401, so they don't dead-end on raw JSON.
// The withAuth/withAdmin wrappers always return JSON, which doesn't fit here.
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { getOAuthSettings, type MicrosoftOAuthSettings } from "@/lib/integrations/oauth-settings";
import { getOAuthProvider, OAUTH_PROVIDERS } from "@/lib/integrations/oauth-providers";
import { encrypt } from "@/lib/encryption";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { redactEmail } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { clearIntegrationAuthError } from "@/lib/integrations/auth-state";
import { eq, and } from "drizzle-orm";

/**
 * Try to decode the OAuth state as a JSON payload (reconnect flow).
 * Falls back to null if it's a plain nonce string (existing connect flow).
 */
function decodeStatePayload(
  state: string
): { nonce?: string; reconnectConnectionId?: string } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf-8");
    const obj = JSON.parse(decoded);
    if (typeof obj === "object" && obj !== null)
      return obj as { nonce?: string; reconnectConnectionId?: string };
    return null;
  } catch {
    return null;
  }
}

function errorRedirect(origin: string, error: string) {
  const url = new URL("/settings", origin);
  url.searchParams.set("tab", "integrations");
  url.searchParams.set("error", error);
  return NextResponse.redirect(url.toString(), 302);
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const origin =
    forwardedProto && forwardedHost ? `${forwardedProto}://${forwardedHost}` : requestUrl.origin;
  const isSecure = (forwardedProto ?? requestUrl.protocol.replace(":", "")) === "https";

  // 1. Validate admin session
  const session = await getSession({ headers: await headers() });
  if (!session?.user || session.user.role !== "admin") {
    return errorRedirect(origin, "unauthorized");
  }

  // 2. Get code and state from query params
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  if (!code || !state) {
    return errorRedirect(origin, "missing_params");
  }

  // 3. CSRF validation: compare state param to oauth_state cookie
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...rest] = c.trim().split("=");
      return [key, rest.join("=")];
    })
  );
  const cookieState = cookies["oauth_state"];
  if (!cookieState || cookieState !== state) {
    return errorRedirect(origin, "state_mismatch");
  }

  // 4. Determine provider from pending connection (set during oauth/start)
  const pendingId = cookies["oauth_pending_id"];
  let pendingType: string = "google";
  if (pendingId) {
    const pendingRows = await db
      .select()
      .from(integrationConnections)
      .where(
        and(eq(integrationConnections.id, pendingId), eq(integrationConnections.status, "pending"))
      )
      .limit(1);
    if (pendingRows.length > 0) {
      pendingType = pendingRows[0].type;
    } else {
      // Pending record gone (expired/cleaned up) — fall back to the provider
      // cookie set by oauth/start so we still know which provider was used.
      pendingType = cookies["oauth_provider"] ?? "google";
    }
  } else {
    // No pending ID at all — fall back to the provider cookie.
    pendingType = cookies["oauth_provider"] ?? "google";
  }

  // Resolve the descriptor; fail-safe to Google (matches the pendingType
  // default). getOAuthProvider avoids object-injection on pendingType.
  const oauthProvider = getOAuthProvider(pendingType) ?? OAUTH_PROVIDERS.google;
  const isMicrosoft = oauthProvider.id === "microsoft";

  // 5. Read OAuth settings for the determined provider
  const settings = await getOAuthSettings(oauthProvider.id);
  if (!settings) {
    return errorRedirect(origin, "not_configured");
  }

  // 6. Build redirect_uri
  const redirectUri = `${origin}/api/integrations/oauth/callback`;

  let access_token: string;
  let refresh_token: string;
  let expires_in: number;
  let scope: string;
  let emailAddress: string;

  if (isMicrosoft) {
    // ── Microsoft authorization-code exchange ────────────────────────────
    const msSettings = settings as MicrosoftOAuthSettings;
    const tenantId = msSettings.tenantId;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uri: redirectUri,
      scope: oauthProvider.scopes,
    });

    const tokenResponse = await fetch(oauthProvider.tokenUrl({ tenantId }), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!tokenResponse.ok) {
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        resource: "integration:microsoft",
        detail: {
          action: "integration_oauth_failed",
          type: "microsoft",
          error: { message: "token_exchange_failed" },
        },
        outcome: "failure",
      });
      return errorRedirect(origin, "token_exchange_failed");
    }

    const tokenData = await tokenResponse.json();
    access_token = tokenData.access_token;
    refresh_token = tokenData.refresh_token;
    expires_in = tokenData.expires_in;
    scope = oauthProvider.scopes;

    // Fetch profile from Microsoft Graph
    const profileResponse = await fetch(oauthProvider.profileUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!profileResponse.ok) {
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        resource: "integration:microsoft",
        detail: {
          action: "integration_oauth_failed",
          type: "microsoft",
          error: { message: "profile_fetch_failed" },
        },
        outcome: "failure",
      });
      return errorRedirect(origin, "profile_fetch_failed");
    }

    const profileData = await profileResponse.json();
    emailAddress = oauthProvider.extractEmail(profileData) ?? "";
  } else {
    // ── Google authorization-code exchange ───────────────────────────────
    const tokenBody = new URLSearchParams({
      code,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const tokenResponse = await fetch(oauthProvider.tokenUrl({}), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!tokenResponse.ok) {
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        resource: "integration:google",
        detail: {
          action: "integration_oauth_failed",
          type: "google",
          error: { message: "token_exchange_failed" },
        },
        outcome: "failure",
      });
      return errorRedirect(origin, "token_exchange_failed");
    }

    const tokenData = await tokenResponse.json();
    access_token = tokenData.access_token;
    refresh_token = tokenData.refresh_token;
    expires_in = tokenData.expires_in;
    scope = tokenData.scope;

    // Fetch email address from Gmail profile
    const profileResponse = await fetch(oauthProvider.profileUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!profileResponse.ok) {
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        resource: "integration:google",
        detail: {
          action: "integration_oauth_failed",
          type: "google",
          error: { message: "profile_fetch_failed" },
        },
        outcome: "failure",
      });
      return errorRedirect(origin, "profile_fetch_failed");
    }

    const profileData = await profileResponse.json();
    emailAddress = oauthProvider.extractEmail(profileData) ?? "";
  }

  // 7. Persist integration — UPDATE pending record if possible, otherwise INSERT
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
  const encryptedCredentials = encrypt(
    JSON.stringify({
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt,
      scope,
    })
  );

  const connectionType = oauthProvider.connectionType;

  const connectionData = {
    emailAddress,
    provider: oauthProvider.auditProvider,
    connectedAt: new Date().toISOString(),
  };

  let connection: typeof integrationConnections.$inferSelect;

  // Check if this is a reconnect (state encodes reconnectConnectionId)
  const statePayload = decodeStatePayload(state);
  const reconnectConnectionId = statePayload?.reconnectConnectionId;

  if (reconnectConnectionId) {
    // Reconnect path: update the existing connection row so that
    // agent_connection_permissions referencing it are preserved.
    // Do NOT set status/lastError/lastErrorAt here — let clearIntegrationAuthError
    // handle the auth_failed → active transition and write the integration.auth_recovered
    // audit event. If the connection was already active this is a no-op there.
    [connection] = await db
      .update(integrationConnections)
      .set({
        name: emailAddress,
        credentials: encryptedCredentials,
        data: connectionData,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, reconnectConnectionId))
      .returning();

    if (!connection) {
      return errorRedirect(origin, "connection_not_found");
    }

    // Clear auth_failed state and write integration.auth_recovered audit if needed
    // (no-op if the connection was already active)
    await clearIntegrationAuthError({
      connectionId: reconnectConnectionId,
      actor: { type: "user", id: session.user.id! },
    });

    // 9a. Audit log for reconnect
    deferAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "integration.credentials_updated",
      resource: `integration:${connection.id}`,
      detail: {
        id: connection.id,
        name: connection.name,
        fields: ["oauth_tokens"],
      },
      outcome: "success",
    });
  } else {
    // Original connect path: UPDATE pending record if possible, otherwise INSERT
    const pendingId = cookies["oauth_pending_id"];

    if (pendingId) {
      const rows = await db
        .select()
        .from(integrationConnections)
        .where(
          and(
            eq(integrationConnections.id, pendingId),
            eq(integrationConnections.status, "pending")
          )
        )
        .limit(1);

      if (rows.length > 0) {
        [connection] = await db
          .update(integrationConnections)
          .set({
            name: emailAddress,
            status: "active",
            credentials: encryptedCredentials,
            data: connectionData,
            updatedAt: new Date(),
          })
          .where(eq(integrationConnections.id, pendingId))
          .returning();
      } else {
        [connection] = await db
          .insert(integrationConnections)
          .values({
            type: connectionType,
            name: emailAddress,
            credentials: encryptedCredentials,
            data: connectionData,
          })
          .returning();
      }
    } else {
      [connection] = await db
        .insert(integrationConnections)
        .values({
          type: connectionType,
          name: emailAddress,
          credentials: encryptedCredentials,
          data: connectionData,
        })
        .returning();
    }
    // 9b. Audit log for new connection
    // GDPR Art. 17: never record the plaintext email address. The audit row
    // is HMAC-signed, so we cannot redact later. redactEmail() gives us a
    // keyed hash + masked preview; the connectionId in `resource` is enough
    // to look up the live mailbox name from the integrations table while it
    // exists. Google and Microsoft use different audit conventions: Google
    // emits the dedicated `integration.created` event; Microsoft (added later)
    // uses the generic `config.changed` event with an `action` discriminator.
    if (isMicrosoft) {
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        resource: `integration:${connection.id}`,
        detail: {
          action: "integration_created",
          type: connectionType,
          ...redactEmail(emailAddress),
        },
        outcome: "success",
      });
    } else {
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "integration.created",
        resource: `integration:${connection.id}`,
        detail: {
          type: "google",
          ...redactEmail(emailAddress),
        },
        outcome: "success",
      });
    }
  }

  // 9. Clean up cookies and redirect
  const successUrl = new URL("/settings", origin);
  successUrl.searchParams.set("tab", "integrations");
  successUrl.searchParams.set("created", connection.id);

  const response = NextResponse.redirect(successUrl.toString(), 302);
  response.cookies.set("oauth_state", "", {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set("oauth_pending_id", "", {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set("oauth_provider", "", {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}

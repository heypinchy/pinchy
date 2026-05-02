// auth-direct: browser-flow callback. The user has just bounced through
// Google's OAuth consent screen; on auth failure we render a redirect to
// /settings, not a JSON 401, so they don't dead-end on raw JSON. The
// withAuth/withAdmin wrappers always return JSON, which doesn't fit here.
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { getOAuthSettings } from "@/lib/integrations/oauth-settings";
import { encrypt } from "@/lib/encryption";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { appendAuditLog, redactEmail } from "@/lib/audit";
import { eq, and } from "drizzle-orm";

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

  // 4. Read Google OAuth settings
  const settings = await getOAuthSettings("google");
  if (!settings) {
    return errorRedirect(origin, "not_configured");
  }

  // 5. Build redirect_uri
  const redirectUri = `${origin}/api/integrations/oauth/callback`;

  // 6. Exchange code for tokens
  const tokenBody = new URLSearchParams({
    code,
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });

  if (!tokenResponse.ok) {
    appendAuditLog({
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
    }).catch(console.error);
    return errorRedirect(origin, "token_exchange_failed");
  }

  const tokenData = await tokenResponse.json();
  const { access_token, refresh_token, expires_in, scope } = tokenData;

  // 7. Fetch email address
  const profileResponse = await fetch("https://www.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!profileResponse.ok) {
    appendAuditLog({
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
    }).catch(console.error);
    return errorRedirect(origin, "profile_fetch_failed");
  }

  const profileData = await profileResponse.json();
  const { emailAddress } = profileData;

  // 8. Persist integration — UPDATE pending record if possible, otherwise INSERT
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
  const encryptedCredentials = encrypt(
    JSON.stringify({
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt,
      scope,
    })
  );

  const connectionData = {
    emailAddress,
    provider: "gmail",
    connectedAt: new Date().toISOString(),
  };

  const pendingId = cookies["oauth_pending_id"];
  let connection: typeof integrationConnections.$inferSelect;

  if (pendingId) {
    const rows = await db
      .select()
      .from(integrationConnections)
      .where(
        and(eq(integrationConnections.id, pendingId), eq(integrationConnections.status, "pending"))
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
          type: "google",
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
        type: "google",
        name: emailAddress,
        credentials: encryptedCredentials,
        data: connectionData,
      })
      .returning();
  }

  // 9. Audit log
  // GDPR Art. 17: never record the plaintext Gmail address. The audit row
  // is HMAC-signed, so we cannot redact later. redactEmail() gives us a
  // keyed hash + masked preview; the connectionId in `resource` is enough
  // to look up the live mailbox name from the integrations table while it
  // exists.
  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.changed",
    resource: `integration:${connection.id}`,
    detail: {
      action: "integration_created",
      type: "google",
      ...redactEmail(emailAddress),
    },
    outcome: "success",
  }).catch(console.error);

  // 10. Clean up cookies and redirect
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

  return response;
}

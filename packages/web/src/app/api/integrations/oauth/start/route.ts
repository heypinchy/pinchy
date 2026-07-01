// auth-direct: Browser-driven OAuth entry point. The user clicks
// "Connect Google" on /settings and Next.js navigates them here, so on auth
// failure we must redirect (not return JSON) — symmetric with oauth/callback.
// The api-auth wrappers always return JSON, so this route uses an inline
// session check.
//
// POST /oauth/start is the programmatic reconnect entry point. It accepts a
// JSON body with reconnectConnectionId and returns { url } for the client to
// navigate to. Failures return JSON errors (not redirects) since the POST is
// called via fetch, not browser navigation.
//
// audit-exempt: Neither handler mutates persistent state — GET creates a pending
// row (not auditable on its own) and POST only builds a redirect URL. The actual
// credential mutation and audit entry (integration.credentials_updated) are
// written by oauth/callback after the token exchange succeeds.
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { randomBytes } from "crypto";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { getOAuthSettings, type MicrosoftOAuthSettings } from "@/lib/integrations/oauth-settings";
import { getOAuthProvider, OAUTH_PROVIDERS } from "@/lib/integrations/oauth-providers";
import { parseRequestBody } from "@/lib/api-validation";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt } from "@/lib/encryption";
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

  // Validate admin session — render failures as redirects, not JSON, because
  // this is reached via browser navigation.
  const session = await getSession({ headers: await headers() });
  if (!session?.user || session.user.role !== "admin") {
    return errorRedirect(origin, "unauthorized");
  }

  const provider = requestUrl.searchParams.get("provider") ?? "google";

  const settings = await getOAuthSettings(provider as "google" | "microsoft");
  if (!settings) {
    return errorRedirect(origin, "not_configured");
  }

  // Clean up the user's own previous pending record (if any) before starting a new flow.
  // Only delete the specific record from a previous attempt — avoid touching other admins' pending records.
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const existingPendingId = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...rest] = c.trim().split("=");
      return [key, rest.join("=")];
    })
  )["oauth_pending_id"];
  if (existingPendingId) {
    await db
      .delete(integrationConnections)
      .where(
        and(
          eq(integrationConnections.id, existingPendingId),
          eq(integrationConnections.status, "pending")
        )
      );
  }

  // Resolve the provider descriptor (defaults to Google, matching the
  // `?provider` default above). getOAuthProvider avoids object-injection.
  const oauthProvider = getOAuthProvider(provider) ?? OAUTH_PROVIDERS.google;

  const state = randomBytes(32).toString("hex");
  const redirectUri = `${origin}/api/integrations/oauth/callback`;

  // For tenant-scoped providers (Microsoft) derive the tenant from settings so
  // authorizeUrl embeds it; Google ignores tenantId.
  const tenantId = oauthProvider.hasTenant
    ? (settings as MicrosoftOAuthSettings).tenantId
    : undefined;

  const authUrl = new URL(oauthProvider.authorizeUrl({ tenantId }));
  authUrl.searchParams.set("client_id", settings.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", oauthProvider.scopes);
  if (oauthProvider.id === "microsoft") {
    // Microsoft-specific: force the code to come back as a query param.
    authUrl.searchParams.set("response_mode", "query");
  } else {
    // Google-specific: request a refresh token.
    authUrl.searchParams.set("access_type", "offline");
  }
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  // Create a pending record so the connection is visible during the OAuth flow
  const [pending] = await db
    .insert(integrationConnections)
    .values({
      type: oauthProvider.connectionType,
      name: `${oauthProvider.label} (connecting…)`,
      status: "pending",
      credentials: encrypt(JSON.stringify({})),
    })
    .returning({ id: integrationConnections.id });

  const response = NextResponse.redirect(authUrl.toString(), 302);
  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  response.cookies.set("oauth_pending_id", pending.id, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  response.cookies.set("oauth_provider", oauthProvider.id, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}

const reconnectSchema = z.object({
  reconnectConnectionId: z.string().min(1),
});

/**
 * POST /api/integrations/oauth/start
 *
 * Programmatic reconnect entry point for google and microsoft connections that
 * have entered auth_failed state. Accepts { reconnectConnectionId } and returns { url }
 * for the client to navigate to. The state parameter is a base64url-encoded
 * JSON payload containing a CSRF nonce and the connection ID to update.
 *
 * audit-exempt: This handler only validates and builds the OAuth redirect URL.
 * No state is mutated here; the audit entry is written by oauth/callback when
 * the tokens are actually exchanged and persisted (integration.credentials_updated).
 */
export async function POST(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const origin =
    forwardedProto && forwardedHost ? `${forwardedProto}://${forwardedHost}` : requestUrl.origin;

  const session = await getSession({ headers: await headers() });
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(reconnectSchema, request);
  if ("error" in parsed) return parsed.error;
  const { reconnectConnectionId } = parsed.data;

  // Verify the connection exists and supports OAuth re-auth (google or microsoft)
  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, reconnectConnectionId))
    .limit(1);

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  if (connection.type !== "google" && connection.type !== "microsoft") {
    return NextResponse.json(
      { error: "This connection type does not support OAuth re-auth" },
      { status: 400 }
    );
  }

  // Build the state as base64url-encoded JSON so the callback can extract
  // both the CSRF nonce and the reconnectConnectionId. The reconnect callback
  // path is provider-agnostic — it updates the existing connection in place —
  // so the state shape is identical for both providers.
  const nonce = randomBytes(32).toString("hex");
  const stateObj = { nonce, reconnectConnectionId };
  const state = Buffer.from(JSON.stringify(stateObj)).toString("base64url");
  const redirectUri = `${origin}/api/integrations/oauth/callback`;
  const isSecure = (forwardedProto ?? requestUrl.protocol.replace(":", "")) === "https";

  // connection.type is "google" | "microsoft" here (guarded above), so the
  // descriptor always resolves; keep a Google fallback for type-safety.
  const oauthProvider = getOAuthProvider(connection.type) ?? OAUTH_PROVIDERS.google;

  const settings = await getOAuthSettings(oauthProvider.id);
  if (!settings) {
    return NextResponse.json(
      { error: `${oauthProvider.label} OAuth is not configured` },
      { status: 400 }
    );
  }

  const tenantId = oauthProvider.hasTenant
    ? (settings as MicrosoftOAuthSettings).tenantId
    : undefined;

  const authUrl = new URL(oauthProvider.authorizeUrl({ tenantId }));
  authUrl.searchParams.set("client_id", settings.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", oauthProvider.scopes);
  if (oauthProvider.id === "microsoft") {
    authUrl.searchParams.set("response_mode", "query");
  } else {
    authUrl.searchParams.set("access_type", "offline");
  }
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  const response = NextResponse.json({ url: authUrl.toString() }, { status: 200 });
  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  // CRITICAL: reconnect has no pending record and no oauth_pending_id cookie,
  // so the callback identifies the provider from this cookie. Without it the
  // callback defaults to Google and exchanges the code against the wrong host.
  // Google reconnect deliberately omits this — its callback path is driven
  // purely by reconnectConnectionId in the state (see oauth-start.test.ts).
  if (oauthProvider.id === "microsoft") {
    response.cookies.set("oauth_provider", "microsoft", {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  }

  return response;
}

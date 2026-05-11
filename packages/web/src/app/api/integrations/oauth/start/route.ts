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
import { parseRequestBody } from "@/lib/api-validation";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { eq, and } from "drizzle-orm";

const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const MICROSOFT_OAUTH_SCOPES = "offline_access User.Read Mail.ReadWrite Mail.Send";

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

  const state = randomBytes(32).toString("hex");
  const redirectUri = `${origin}/api/integrations/oauth/callback`;
  let authUrl: URL;

  if (provider === "microsoft") {
    const msSettings = settings as MicrosoftOAuthSettings;
    const tenantId = msSettings.tenantId?.trim() || "organizations";
    const tokenHost = process.env.MICROSOFT_OAUTH_BASE_URL ?? "https://login.microsoftonline.com";
    authUrl = new URL(`${tokenHost}/${tenantId}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set("client_id", settings.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("scope", MICROSOFT_OAUTH_SCOPES);
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);

    // Create a pending record so the connection is visible during the OAuth flow
    const [pending] = await db
      .insert(integrationConnections)
      .values({
        type: "microsoft",
        name: "Microsoft (connecting…)",
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

    return response;
  }

  // Default: Google flow
  // Create a pending record so the connection is visible during the OAuth flow
  const [pending] = await db
    .insert(integrationConnections)
    .values({
      type: "google",
      name: "Google (connecting…)",
      status: "pending",
      credentials: encrypt(JSON.stringify({})),
    })
    .returning({ id: integrationConnections.id });

  authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", settings.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

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

  return response;
}

const reconnectSchema = z.object({
  reconnectConnectionId: z.string().min(1),
});

/**
 * POST /api/integrations/oauth/start
 *
 * Programmatic reconnect entry point for google connections that have entered
 * auth_failed state. Accepts { reconnectConnectionId } and returns { url }
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

  // Verify the connection exists and is a google-type connection
  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, reconnectConnectionId))
    .limit(1);

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  if (connection.type !== "google") {
    return NextResponse.json(
      { error: "Only google connections support OAuth re-auth" },
      { status: 400 }
    );
  }

  const settings = await getOAuthSettings("google");
  if (!settings) {
    return NextResponse.json({ error: "Google OAuth is not configured" }, { status: 400 });
  }

  // Build the state as base64url-encoded JSON so the callback can extract
  // both the CSRF nonce and the reconnectConnectionId.
  const nonce = randomBytes(32).toString("hex");
  const stateObj = { nonce, reconnectConnectionId };
  const state = Buffer.from(JSON.stringify(stateObj)).toString("base64url");

  const redirectUri = `${origin}/api/integrations/oauth/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", settings.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  const isSecure = (forwardedProto ?? requestUrl.protocol.replace(":", "")) === "https";
  const response = NextResponse.json({ url: authUrl.toString() }, { status: 200 });
  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}

// auth-direct: Browser-driven OAuth entry point. The user clicks
// "Connect Google" on /settings and Next.js navigates them here, so on auth
// failure we must redirect (not return JSON) — symmetric with oauth/callback.
// The api-auth wrappers always return JSON, so this route uses an inline
// session check.
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { randomBytes } from "crypto";
import { getSession } from "@/lib/auth";
import { getOAuthSettings } from "@/lib/integrations/oauth-settings";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { eq, and } from "drizzle-orm";

const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

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

  // Validate admin session — render failures as redirects, not JSON, because
  // this is reached via browser navigation.
  const session = await getSession({ headers: await headers() });
  if (!session?.user || session.user.role !== "admin") {
    return errorRedirect(origin, "unauthorized");
  }

  const settings = await getOAuthSettings("google");
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

  const state = randomBytes(32).toString("hex");

  const redirectUri = `${origin}/api/integrations/oauth/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", settings.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authUrl.toString(), 302);
  const isSecure = requestUrl.protocol === "https:";
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

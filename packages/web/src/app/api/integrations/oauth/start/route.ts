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

export async function GET(request: Request) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const settings = await getOAuthSettings("google");
  if (!settings) {
    return NextResponse.json({ error: "Google OAuth not configured" }, { status: 400 });
  }

  // Clean up any stale pending records before starting a new flow
  await db
    .delete(integrationConnections)
    .where(
      and(eq(integrationConnections.type, "google"), eq(integrationConnections.status, "pending"))
    );

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

  const requestUrl = new URL(request.url);
  const redirectUri = `${requestUrl.origin}/api/integrations/oauth/callback`;

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

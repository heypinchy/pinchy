// audit-exempt: internal endpoint called by OpenClaw plugin, not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "@/lib/encryption";
import { isTokenExpired, refreshAccessToken } from "@/lib/integrations/google-oauth";
import { getSetting } from "@/lib/settings";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { connectionId } = await params;

  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const connection = rows[0];

  let credentials;
  try {
    credentials = JSON.parse(decrypt(connection.credentials));
  } catch {
    return NextResponse.json({ error: "Failed to decrypt credentials" }, { status: 500 });
  }

  // Auto-refresh expired Google OAuth tokens
  if (connection.type === "google" && credentials.expiresAt && credentials.refreshToken) {
    if (isTokenExpired(credentials.expiresAt)) {
      try {
        const oauthSettingsRaw = await getSetting("google_oauth_credentials");
        if (oauthSettingsRaw) {
          const oauthSettings = JSON.parse(oauthSettingsRaw) as {
            clientId: string;
            clientSecret: string;
          };
          const refreshed = await refreshAccessToken({
            refreshToken: credentials.refreshToken,
            clientId: oauthSettings.clientId,
            clientSecret: oauthSettings.clientSecret,
          });

          credentials.accessToken = refreshed.accessToken;
          credentials.expiresAt = refreshed.expiresAt;

          // Persist the refreshed credentials back to DB
          await db
            .update(integrationConnections)
            .set({ credentials: encrypt(JSON.stringify(credentials)) })
            .where(eq(integrationConnections.id, connectionId));
        }
      } catch {
        // If refresh fails, return existing (possibly expired) credentials
        // and let the plugin handle the error
      }
    }
  }

  return NextResponse.json({ type: connection.type, credentials });
}

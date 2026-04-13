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

  // Auto-refresh expired Google OAuth tokens (graceful degradation: return old credentials on failure)
  if (
    connection.type === "google" &&
    credentials.expiresAt &&
    isTokenExpired(credentials.expiresAt)
  ) {
    try {
      const oauthSettingsRaw = await getSetting("google_oauth_credentials");
      if (!oauthSettingsRaw) {
        console.error("Google OAuth token refresh failed: OAuth settings not configured");
      } else {
        const { clientId, clientSecret } = JSON.parse(oauthSettingsRaw) as {
          clientId: string;
          clientSecret: string;
        };
        const refreshed = await refreshAccessToken({
          refreshToken: credentials.refreshToken,
          clientId,
          clientSecret,
        });

        credentials.accessToken = refreshed.accessToken;
        credentials.expiresAt = refreshed.expiresAt;

        // Persist the refreshed credentials back to DB
        await db
          .update(integrationConnections)
          .set({
            credentials: encrypt(JSON.stringify(credentials)),
            updatedAt: new Date(),
          })
          .where(eq(integrationConnections.id, connectionId));
      }
    } catch (err) {
      console.error("Google OAuth token refresh failed:", err);
    }
  }

  return NextResponse.json({ type: connection.type, credentials });
}

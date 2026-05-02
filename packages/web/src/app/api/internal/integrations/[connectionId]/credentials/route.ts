// audit-exempt: internal endpoint called by OpenClaw plugin, not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "@/lib/encryption";
import { isTokenExpired, refreshAccessToken } from "@/lib/integrations/google-oauth";
import { getOAuthSettings } from "@/lib/integrations/oauth-settings";

interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  [k: string]: unknown;
}

// Per-connectionId in-flight refresh tracker. When a Google access token has
// expired and multiple plugin calls arrive concurrently, only the first caller
// fires refreshAccessToken; the rest await the same Promise and observe the
// same fresh token. Without this, every concurrent caller would burn a refresh
// against Google with the same refresh_token, and refresh-token rotation means
// all but one fail with invalid_grant — corrupting the stored credential bundle.
// See issue #237.
const inFlightGoogleRefreshes = new Map<string, Promise<GoogleCredentials>>();

async function refreshGoogleCredentials(
  connectionId: string,
  current: GoogleCredentials
): Promise<GoogleCredentials> {
  const existing = inFlightGoogleRefreshes.get(connectionId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const oauthSettings = await getOAuthSettings("google");
      if (!oauthSettings) {
        console.error("Google OAuth token refresh failed: OAuth settings not configured");
        return current;
      }

      const refreshed = await refreshAccessToken({
        refreshToken: current.refreshToken,
        clientId: oauthSettings.clientId,
        clientSecret: oauthSettings.clientSecret,
      });

      const updated: GoogleCredentials = {
        ...current,
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
      };

      await db
        .update(integrationConnections)
        .set({
          credentials: encrypt(JSON.stringify(updated)),
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, connectionId));

      console.log("Refreshed Google OAuth token for connection", connectionId);
      return updated;
    } catch (err) {
      console.error("Google OAuth token refresh failed:", err);
      return current;
    }
  })().finally(() => {
    inFlightGoogleRefreshes.delete(connectionId);
  });

  inFlightGoogleRefreshes.set(connectionId, promise);
  return promise;
}

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

  if (connection.status === "pending") {
    return NextResponse.json({ error: "Connection not active" }, { status: 403 });
  }

  let credentials;
  try {
    credentials = JSON.parse(decrypt(connection.credentials));
  } catch {
    return NextResponse.json({ error: "Failed to decrypt credentials" }, { status: 500 });
  }

  // Auto-refresh expired Google OAuth tokens (graceful degradation: return old credentials on failure).
  // Concurrent callers for the same connectionId share a single refresh via inFlightGoogleRefreshes.
  if (
    connection.type === "google" &&
    credentials.expiresAt &&
    isTokenExpired(credentials.expiresAt)
  ) {
    credentials = await refreshGoogleCredentials(connectionId, credentials as GoogleCredentials);
  }

  return NextResponse.json({ type: connection.type, credentials });
}

// audit-exempt: internal endpoint called by OpenClaw plugin, not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "@/lib/encryption";
import { refreshAccessToken } from "@/lib/integrations/google-oauth";
import { isTokenExpired, createRefreshDedup } from "@/lib/integrations/oauth-token";
import { getOAuthSettings } from "@/lib/integrations/oauth-settings";
import {
  refreshMicrosoftCredentials,
  OAuthSettingsMissingError,
} from "@/lib/integrations/microsoft-refresh";

interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  [k: string]: unknown;
}

// Per-connectionId in-flight refresh tracker used by the Google refresh path
// (see createRefreshDedup in oauth-token.ts for the full rationale / issue
// #237). The Microsoft equivalent lives in @/lib/integrations/microsoft-refresh.
const dedupeGoogleRefresh = createRefreshDedup<GoogleCredentials>();

async function refreshGoogleCredentials(
  connectionId: string,
  current: GoogleCredentials
): Promise<GoogleCredentials> {
  return dedupeGoogleRefresh(connectionId, async () => {
    try {
      const oauthSettings = await getOAuthSettings("google");
      if (!oauthSettings) {
        console.error("Google OAuth token refresh failed: OAuth settings not configured");
        throw new OAuthSettingsMissingError("Google");
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
      if (err instanceof OAuthSettingsMissingError) {
        // Re-throw: there is no safe stale fallback when settings are missing
        // and a refresh is required (see class comment above).
        throw err;
      }
      console.error("Google OAuth token refresh failed:", err);
      return current;
    }
  });
}

// Shared minimal shape both GoogleCredentials and MicrosoftCredentials satisfy.
// Used only for the dispatch lookup below; refreshGoogleCredentials and
// refreshMicrosoftCredentials keep their own precise parameter/return types
// internally. expiresAt is required here (rather than optional) because the
// dispatch call site below only invokes refreshFn once credentials.expiresAt
// has already been checked truthy, and MicrosoftCredentials.expiresAt is
// itself required — a required field here keeps both refresh functions
// structurally assignable to this table without widening either one.
interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  [k: string]: unknown;
}

// Dispatch table keyed by connection.type. connection.type comes from the DB
// column, not user input, but the lookup is still guarded by the `refreshFn &&`
// truthiness check below (a plain object, no prototype pollution surface) —
// a type outside this table (e.g. "odoo", "web-search") simply misses and no
// refresh is attempted, matching the old per-provider `if` gates exactly.
const REFRESH_BY_TYPE: Record<
  string,
  (connectionId: string, current: OAuthCredentials) => Promise<Record<string, unknown>>
> = {
  google: refreshGoogleCredentials,
  microsoft: refreshMicrosoftCredentials,
};

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
    // The plugins surface this body.error into the agent's tool error, so a bare
    // "Connection not found" reaches the user as an opaque "technical problem
    // (error 404)". Make it actionable and provider-generic: the connection was
    // removed or replaced (e.g. deleted + re-added, which mints a new id and
    // orphans this reference), and an admin fixes it under Settings → Integrations.
    return NextResponse.json(
      {
        error:
          "This integration is no longer connected — it may have been removed or replaced. An admin can reconnect it under Settings → Integrations.",
      },
      { status: 404 }
    );
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

  // Auto-refresh expired OAuth tokens for whichever provider this connection
  // is. The persist policy on a failed refresh differs per provider and lives
  // in the respective refresh function: Google degrades gracefully to the
  // current credentials (safe — Google does not rotate refresh tokens), while
  // Microsoft retries the DB persist once and then throws rather than ever
  // discarding a rotated refresh token (issue #237 — Microsoft DOES rotate,
  // so losing that token bricks the mailbox). Missing OAuth settings fail
  // loudly for either provider (see OAuthSettingsMissingError). Concurrent
  // callers for the same connectionId share a single refresh via each
  // provider's own in-flight dedup.
  const refreshFn = REFRESH_BY_TYPE[connection.type];
  if (refreshFn && credentials.expiresAt && isTokenExpired(credentials.expiresAt)) {
    try {
      credentials = await refreshFn(connectionId, credentials as OAuthCredentials);
    } catch (err) {
      if (err instanceof OAuthSettingsMissingError) {
        // The access token is expired and there is no way to refresh it —
        // fail loudly instead of returning a 200 with stale/expired tokens
        // that the plugin would cache for another 5 minutes and fail on.
        return NextResponse.json(
          {
            error: `${err.provider} OAuth settings missing — reconnect the mailbox or restore the OAuth app`,
          },
          { status: 503 }
        );
      }
      throw err;
    }
  }

  return NextResponse.json({ type: connection.type, credentials });
}

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import { refreshAccessToken } from "@/lib/integrations/google-oauth";
import { isTokenExpired, createRefreshDedup } from "@/lib/integrations/oauth-token";
import { getOAuthSettings } from "@/lib/integrations/oauth-settings";
import {
  refreshMicrosoftCredentials,
  OAuthSettingsMissingError,
} from "@/lib/integrations/microsoft-refresh";

/**
 * Resolve a connection's decrypted, refreshed credentials — the single seam both
 * the internal credentials route (which maps failures to HTTP status codes) and
 * the Inbox Agent's mailbox port (which lets them propagate to the sweep as the
 * workflow's `error` status) share, so the tricky decrypt + OAuth-refresh +
 * re-encrypt logic lives in exactly one place.
 *
 * Failures are *typed*, not HTTP responses: callers decide how to surface them.
 * {@link OAuthSettingsMissingError} (re-exported from microsoft-refresh) is the
 * fourth case — the token is expired and cannot be refreshed.
 */
export class ConnectionNotFoundError extends Error {
  constructor(public readonly connectionId: string) {
    super(`Integration connection ${connectionId} not found`);
    this.name = "ConnectionNotFoundError";
  }
}

export class ConnectionNotActiveError extends Error {
  constructor(public readonly connectionId: string) {
    super(`Integration connection ${connectionId} is not active`);
    this.name = "ConnectionNotActiveError";
  }
}

export class CredentialsDecryptError extends Error {
  constructor(public readonly connectionId: string) {
    super(`Failed to decrypt credentials for connection ${connectionId}`);
    this.name = "CredentialsDecryptError";
  }
}

export { OAuthSettingsMissingError };

export interface ResolvedCredentials {
  type: string;
  credentials: Record<string, unknown>;
}

interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  [k: string]: unknown;
}

// Per-connectionId in-flight refresh tracker for the Google path (see
// createRefreshDedup / issue #237). The Microsoft equivalent lives in
// microsoft-refresh.ts. Module-level so concurrent resolvers for the same
// connection share one refresh.
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
        .set({ credentials: encrypt(JSON.stringify(updated)), updatedAt: new Date() })
        .where(eq(integrationConnections.id, connectionId));

      console.log("Refreshed Google OAuth token for connection", connectionId);
      return updated;
    } catch (err) {
      if (err instanceof OAuthSettingsMissingError) {
        // No safe stale fallback when settings are missing and a refresh is
        // required — re-throw.
        throw err;
      }
      console.error("Google OAuth token refresh failed:", err);
      return current;
    }
  });
}

// Shared minimal shape both GoogleCredentials and MicrosoftCredentials satisfy;
// expiresAt is required so both refresh functions stay structurally assignable
// (the call site only invokes a refresh once expiresAt is truthy).
interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  [k: string]: unknown;
}

// Dispatch keyed by connection.type (a DB column, not user input); a type
// outside this table (imap, odoo, web-search) simply misses and no refresh is
// attempted.
const REFRESH_BY_TYPE: Record<
  string,
  (connectionId: string, current: OAuthCredentials) => Promise<Record<string, unknown>>
> = {
  google: refreshGoogleCredentials,
  microsoft: refreshMicrosoftCredentials,
};

export async function resolveConnectionCredentials(
  connectionId: string
): Promise<ResolvedCredentials> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);

  if (rows.length === 0) {
    throw new ConnectionNotFoundError(connectionId);
  }

  const connection = rows[0];
  if (connection.status === "pending") {
    throw new ConnectionNotActiveError(connectionId);
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(decrypt(connection.credentials));
  } catch {
    throw new CredentialsDecryptError(connectionId);
  }

  // Auto-refresh expired OAuth tokens. The per-provider persist policy on a
  // failed refresh lives in each refresh function (Google degrades to current;
  // Microsoft retries then throws rather than dropping a rotated token — #237).
  // Missing OAuth settings throw OAuthSettingsMissingError for the caller to map.
  const refreshFn = REFRESH_BY_TYPE[connection.type];
  if (refreshFn && credentials.expiresAt && isTokenExpired(credentials.expiresAt as string)) {
    credentials = await refreshFn(connectionId, credentials as unknown as OAuthCredentials);
  }

  return { type: connection.type, credentials };
}

import {
  GOOGLE_OAUTH_SETTINGS_KEY,
  MICROSOFT_OAUTH_SETTINGS_KEY,
} from "@/lib/integrations/oauth-settings";

/**
 * Single source of truth for the ~90% overlap between the Google and Microsoft
 * OAuth flows. This module captures the *differences* between providers as
 * data so the start/callback routes (and future UI) can branch on a descriptor
 * lookup instead of duplicating `if (provider === "microsoft")` ladders.
 *
 * This file only defines the registry — consumers are migrated onto it in
 * follow-up changes, so behaviour is unchanged for now.
 */

/**
 * Google OAuth scopes for the Gmail connect flow. Kept here as the single
 * source; oauth/start imports these so the two never drift.
 */
export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

/**
 * Microsoft OAuth scopes for the Outlook / Microsoft 365 connect flow.
 */
export const MICROSOFT_OAUTH_SCOPES = "offline_access User.Read Mail.ReadWrite Mail.Send";

export type OAuthProviderId = "google" | "microsoft";

export interface OAuthProviderDescriptor {
  id: OAuthProviderId;
  /** Human-readable label for UI ("Google" | "Microsoft"). */
  label: string;
  /** Settings key under which the client id/secret are stored. */
  settingsKey: string;
  /** Space-separated OAuth scope string. */
  scopes: string;
  /** Whether the provider is tenant-scoped (Microsoft) or not (Google). */
  hasTenant: boolean;
  /** integrationConnections.type value ( == id, but explicit for clarity). */
  connectionType: string;
  /** Mailbox provider recorded in connection data / audit rows. */
  auditProvider: string;
  /** Path to the per-provider setup guide in the docs. */
  docsPath: string;
  /** Build the provider's authorization endpoint URL. */
  authorizeUrl(opts: { tenantId?: string }): string;
  /**
   * Defensively extract the mailbox email from a fetched profile payload.
   * `profile` is unknown because it comes from a third-party API response.
   */
  extractEmail(profile: unknown): string | undefined;
}

/** Coerce a value to a non-empty string, or undefined otherwise. */
function asNonEmptyString(candidate: unknown): string | undefined {
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** Narrow an unknown profile payload to an indexable record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

const MICROSOFT_LOGIN_DEFAULT = "https://login.microsoftonline.com";

export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderDescriptor> = {
  google: {
    id: "google",
    label: "Google",
    settingsKey: GOOGLE_OAUTH_SETTINGS_KEY,
    scopes: GOOGLE_OAUTH_SCOPES,
    hasTenant: false,
    connectionType: "google",
    auditProvider: "gmail",
    docsPath: "/guides/connect-email-google",
    authorizeUrl() {
      return "https://accounts.google.com/o/oauth2/v2/auth";
    },
    extractEmail(profile) {
      // The Gmail v1 profile endpoint returns the mailbox under `emailAddress`.
      const record = asRecord(profile);
      return record ? asNonEmptyString(record.emailAddress) : undefined;
    },
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft",
    settingsKey: MICROSOFT_OAUTH_SETTINGS_KEY,
    scopes: MICROSOFT_OAUTH_SCOPES,
    hasTenant: true,
    connectionType: "microsoft",
    auditProvider: "outlook",
    docsPath: "/guides/connect-email-microsoft",
    authorizeUrl({ tenantId } = {}) {
      const tenant = tenantId?.trim() || "organizations";
      const tokenHost = process.env.MICROSOFT_OAUTH_BASE_URL ?? MICROSOFT_LOGIN_DEFAULT;
      return `${tokenHost}/${tenant}/oauth2/v2.0/authorize`;
    },
    extractEmail(profile) {
      // Microsoft Graph returns `mail` for work/school accounts, but personal
      // accounts leave it null and only populate `userPrincipalName`.
      const record = asRecord(profile);
      if (!record) return undefined;
      return asNonEmptyString(record.mail) ?? asNonEmptyString(record.userPrincipalName);
    },
  },
};

/**
 * Resolve a provider descriptor by id. Returns null for unknown ids (e.g.
 * "odoo") so callers can branch on OAuth vs non-OAuth connection types.
 */
export function getOAuthProvider(id: string): OAuthProviderDescriptor | null {
  if (id === "google") return OAUTH_PROVIDERS.google;
  if (id === "microsoft") return OAUTH_PROVIDERS.microsoft;
  return null;
}

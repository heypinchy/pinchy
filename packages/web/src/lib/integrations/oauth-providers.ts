/**
 * Single source of truth for the ~90% overlap between the Google and Microsoft
 * OAuth flows. This module captures the *differences* between providers as
 * data so the start/callback routes (and future UI) can branch on a descriptor
 * lookup instead of duplicating `if (provider === "microsoft")` ladders.
 *
 * IMPORTANT: this module must stay client-safe. It is imported by Client
 * Components (the Connected apps section, the connect-step wizard, the edit
 * dialog), so it must NOT pull in the server-only settings/db layer. That is
 * why the settings-storage keys below are defined HERE and re-exported by
 * oauth-settings.ts (server-only) — not the other way around. Importing them
 * from oauth-settings.ts would drag `@/lib/settings` → `db` → `postgres` into
 * the client bundle and break the build.
 */

/**
 * Settings-storage keys for the per-provider OAuth app credentials. The
 * single source of truth lives in this client-safe module; oauth-settings.ts
 * re-exports them for its own (server-side) consumers.
 */
export const GOOGLE_OAUTH_SETTINGS_KEY = "google_oauth_credentials";
export const MICROSOFT_OAUTH_SETTINGS_KEY = "microsoft_oauth_credentials";

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

/**
 * Single source of truth for the `integrationConnections.type` values that
 * count as "email" across the web package: the templates-availability route,
 * the agent-settings email permission section, and the OpenClaw config
 * builder all import this instead of declaring their own local copy.
 *
 * Historically this list also included "imap", but there has never been an
 * IMAP OAuth flow, an IMAP adapter (see `packages/plugins/pinchy-email/`),
 * or any code path that writes `type: "imap"` into `integration_connections`
 * — the only write paths are the OAuth callback route (google/microsoft) and
 * the generic integrations POST route (odoo/web-search only). "imap" was
 * unreachable dead weight, so it was dropped when this constant was
 * consolidated. If an IMAP connect flow is ever built, add "imap" here (and
 * widen `OAuthProviderId`/`getOAuthProvider` as needed) rather than
 * resurrecting a separate local list.
 */
export const EMAIL_CONNECTION_TYPES = [
  "google",
  "microsoft",
] as const satisfies readonly OAuthProviderId[];

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
   * Build the provider's token-exchange endpoint URL. Microsoft is
   * tenant-scoped (same host/tenant logic as authorizeUrl); Google is static.
   */
  tokenUrl(opts: { tenantId?: string }): string;
  /**
   * The provider's profile endpoint URL, used to look up the mailbox email
   * after the token exchange. Implemented as a getter for Microsoft so the
   * `GRAPH_API_BASE_URL` env override is read lazily (tests stub it).
   */
  readonly profileUrl: string;
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
const MICROSOFT_GRAPH_DEFAULT = "https://graph.microsoft.com";

/**
 * Resolve the Microsoft login host + effective tenant used by both the
 * authorize and token endpoints, so the two can never drift. The host honours
 * the `MICROSOFT_OAUTH_BASE_URL` env override (staging/mock); the tenant falls
 * back to "organizations" when absent or blank.
 */
function microsoftHostAndTenant(tenantId?: string): { host: string; tenant: string } {
  const tenant = tenantId?.trim() || "organizations";
  const host = process.env.MICROSOFT_OAUTH_BASE_URL ?? MICROSOFT_LOGIN_DEFAULT;
  return { host, tenant };
}

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
    tokenUrl() {
      return "https://oauth2.googleapis.com/token";
    },
    // The Google connect flow reads the mailbox from the Gmail v1 profile.
    profileUrl: "https://www.googleapis.com/gmail/v1/users/me/profile",
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
      const { host, tenant } = microsoftHostAndTenant(tenantId);
      return `${host}/${tenant}/oauth2/v2.0/authorize`;
    },
    tokenUrl({ tenantId } = {}) {
      const { host, tenant } = microsoftHostAndTenant(tenantId);
      return `${host}/${tenant}/oauth2/v2.0/token`;
    },
    // Getter so the GRAPH_API_BASE_URL env override is read lazily (staging/mock).
    get profileUrl() {
      const graphBase = process.env.GRAPH_API_BASE_URL ?? MICROSOFT_GRAPH_DEFAULT;
      return `${graphBase}/v1.0/me`;
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

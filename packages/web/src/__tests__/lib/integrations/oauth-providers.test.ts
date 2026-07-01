import { describe, it, expect, afterEach, vi } from "vitest";
import {
  OAUTH_PROVIDERS,
  getOAuthProvider,
  GOOGLE_OAUTH_SCOPES,
  MICROSOFT_OAUTH_SCOPES,
} from "@/lib/integrations/oauth-providers";
import {
  GOOGLE_OAUTH_SETTINGS_KEY,
  MICROSOFT_OAUTH_SETTINGS_KEY,
} from "@/lib/integrations/oauth-settings";

describe("OAUTH_PROVIDERS descriptor", () => {
  describe("registry membership", () => {
    it("contains both google and microsoft descriptors keyed by id", () => {
      expect(OAUTH_PROVIDERS.google.id).toBe("google");
      expect(OAUTH_PROVIDERS.microsoft.id).toBe("microsoft");
    });

    it("resolves known providers via getOAuthProvider", () => {
      expect(getOAuthProvider("google")).toBe(OAUTH_PROVIDERS.google);
      expect(getOAuthProvider("microsoft")).toBe(OAUTH_PROVIDERS.microsoft);
    });

    it("returns null for unknown provider ids", () => {
      expect(getOAuthProvider("odoo")).toBeNull();
      expect(getOAuthProvider("")).toBeNull();
      expect(getOAuthProvider("Google")).toBeNull(); // case-sensitive
    });
  });

  describe("descriptor fields", () => {
    it("carries human labels", () => {
      expect(OAUTH_PROVIDERS.google.label).toBe("Google");
      expect(OAUTH_PROVIDERS.microsoft.label).toBe("Microsoft");
    });

    it("single-sources the settings keys from oauth-settings", () => {
      expect(OAUTH_PROVIDERS.google.settingsKey).toBe(GOOGLE_OAUTH_SETTINGS_KEY);
      expect(OAUTH_PROVIDERS.microsoft.settingsKey).toBe(MICROSOFT_OAUTH_SETTINGS_KEY);
    });

    it("single-sources the scopes", () => {
      expect(OAUTH_PROVIDERS.google.scopes).toBe(GOOGLE_OAUTH_SCOPES);
      expect(OAUTH_PROVIDERS.microsoft.scopes).toBe(MICROSOFT_OAUTH_SCOPES);
    });

    it("keeps the current scope contents (drift guard)", () => {
      // These mirror the values previously inlined in oauth/start/route.ts.
      // If OAuth scopes legitimately change, update BOTH here and the consumers.
      expect(GOOGLE_OAUTH_SCOPES).toBe(
        [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/userinfo.email",
        ].join(" ")
      );
      expect(MICROSOFT_OAUTH_SCOPES).toBe("offline_access User.Read Mail.ReadWrite Mail.Send");
    });

    it("marks only microsoft as tenant-scoped", () => {
      expect(OAUTH_PROVIDERS.google.hasTenant).toBe(false);
      expect(OAUTH_PROVIDERS.microsoft.hasTenant).toBe(true);
    });

    it("exposes the connection type equal to the id", () => {
      expect(OAUTH_PROVIDERS.google.connectionType).toBe("google");
      expect(OAUTH_PROVIDERS.microsoft.connectionType).toBe("microsoft");
    });

    it("maps to the mailbox provider used in audit/data rows", () => {
      expect(OAUTH_PROVIDERS.google.auditProvider).toBe("gmail");
      expect(OAUTH_PROVIDERS.microsoft.auditProvider).toBe("outlook");
    });

    it("points at the per-provider setup guide", () => {
      expect(OAUTH_PROVIDERS.google.docsPath).toBe("/guides/connect-email-google");
      expect(OAUTH_PROVIDERS.microsoft.docsPath).toBe("/guides/connect-email-microsoft");
    });
  });

  describe("authorizeUrl", () => {
    it("builds the Google authorization endpoint", () => {
      const url = OAUTH_PROVIDERS.google.authorizeUrl({});
      expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
    });

    it("ignores tenantId for Google", () => {
      const url = OAUTH_PROVIDERS.google.authorizeUrl({ tenantId: "t1" });
      expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(url).not.toContain("/t1/");
    });

    it("embeds the tenant id for Microsoft", () => {
      const url = OAUTH_PROVIDERS.microsoft.authorizeUrl({ tenantId: "t1" });
      expect(url).toContain("login.microsoftonline.com/t1/oauth2/v2.0/authorize");
    });

    it("falls back to the organizations tenant for Microsoft when tenant is absent/blank", () => {
      expect(OAUTH_PROVIDERS.microsoft.authorizeUrl({})).toContain(
        "login.microsoftonline.com/organizations/oauth2/v2.0/authorize"
      );
      expect(OAUTH_PROVIDERS.microsoft.authorizeUrl({ tenantId: "   " })).toContain(
        "/organizations/"
      );
    });
  });

  describe("tokenUrl", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("builds the static Google token endpoint", () => {
      expect(OAUTH_PROVIDERS.google.tokenUrl({})).toBe("https://oauth2.googleapis.com/token");
    });

    it("ignores tenantId for Google", () => {
      expect(OAUTH_PROVIDERS.google.tokenUrl({ tenantId: "t1" })).toBe(
        "https://oauth2.googleapis.com/token"
      );
    });

    it("embeds the tenant id for Microsoft", () => {
      expect(OAUTH_PROVIDERS.microsoft.tokenUrl({ tenantId: "t1" })).toBe(
        "https://login.microsoftonline.com/t1/oauth2/v2.0/token"
      );
    });

    it("falls back to the organizations tenant for Microsoft when tenant is absent/blank", () => {
      expect(OAUTH_PROVIDERS.microsoft.tokenUrl({})).toBe(
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
      );
      expect(OAUTH_PROVIDERS.microsoft.tokenUrl({ tenantId: "   " })).toBe(
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
      );
    });

    it("honours MICROSOFT_OAUTH_BASE_URL env override for the token host", () => {
      vi.stubEnv("MICROSOFT_OAUTH_BASE_URL", "https://mock-ms-auth.local");
      expect(OAUTH_PROVIDERS.microsoft.tokenUrl({ tenantId: "t1" })).toBe(
        "https://mock-ms-auth.local/t1/oauth2/v2.0/token"
      );
    });
  });

  describe("profileUrl", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reads the Gmail v1 profile endpoint for Google", () => {
      expect(OAUTH_PROVIDERS.google.profileUrl).toBe(
        "https://www.googleapis.com/gmail/v1/users/me/profile"
      );
    });

    it("reads the Microsoft Graph /v1.0/me endpoint", () => {
      expect(OAUTH_PROVIDERS.microsoft.profileUrl).toBe("https://graph.microsoft.com/v1.0/me");
    });

    it("honours GRAPH_API_BASE_URL env override for the Microsoft profile host", () => {
      vi.stubEnv("GRAPH_API_BASE_URL", "https://mock-graph.local");
      // profileUrl must be a getter so env overrides are read lazily.
      expect(OAUTH_PROVIDERS.microsoft.profileUrl).toBe("https://mock-graph.local/v1.0/me");
    });
  });

  describe("extractEmail", () => {
    it("reads the Microsoft mail field, falling back to userPrincipalName", () => {
      expect(OAUTH_PROVIDERS.microsoft.extractEmail({ mail: "a@x" })).toBe("a@x");
      expect(OAUTH_PROVIDERS.microsoft.extractEmail({ mail: null, userPrincipalName: "b@x" })).toBe(
        "b@x"
      );
    });

    it("reads the Google Gmail-profile emailAddress field", () => {
      // The Google connect flow fetches the Gmail v1 profile
      // (https://www.googleapis.com/gmail/v1/users/me/profile), whose email key
      // is `emailAddress` — NOT `email`. Verified against oauth/callback/route.ts
      // so a future consumer swap stays behavior-neutral.
      expect(OAUTH_PROVIDERS.google.extractEmail({ emailAddress: "c@x" })).toBe("c@x");
    });

    it("returns undefined for empty or non-object profiles", () => {
      expect(OAUTH_PROVIDERS.google.extractEmail({})).toBeUndefined();
      expect(OAUTH_PROVIDERS.microsoft.extractEmail({})).toBeUndefined();
      expect(OAUTH_PROVIDERS.google.extractEmail(null)).toBeUndefined();
      expect(OAUTH_PROVIDERS.microsoft.extractEmail(undefined)).toBeUndefined();
      expect(OAUTH_PROVIDERS.google.extractEmail("nope")).toBeUndefined();
    });
  });
});

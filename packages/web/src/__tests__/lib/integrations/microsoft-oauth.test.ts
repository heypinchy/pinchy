import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refreshAccessToken } from "@/lib/integrations/microsoft-oauth";
// isTokenExpired is shared across all providers; test it directly against its
// source module instead of via microsoft-oauth's re-export (see D14 cleanup).
import { isTokenExpired } from "@/lib/integrations/oauth-token";
import { MICROSOFT_OAUTH_SCOPES, OAUTH_PROVIDERS } from "@/lib/integrations/oauth-providers";
import { resetInsecureMockWarningsForTest } from "@/lib/integrations/insecure-mock-base-url";

describe("microsoft-oauth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MICROSOFT_OAUTH_BASE_URL;
    delete process.env.PINCHY_INSECURE_MAIL_MOCK;
    resetInsecureMockWarningsForTest();
    vi.restoreAllMocks();
  });

  it("isTokenExpired returns true when within the 5-minute buffer", () => {
    const exp = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    expect(isTokenExpired(exp)).toBe(true);
  });

  it("isTokenExpired returns false when more than 5 minutes remain", () => {
    const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(isTokenExpired(exp)).toBe(false);
  });

  it("refreshAccessToken builds the URL with the given tenant", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });
    const result = await refreshAccessToken({
      tenantId: "my-tenant",
      refreshToken: "old-refresh",
      clientId: "cid",
      clientSecret: "csec",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/my-tenant/oauth2/v2.0/token",
      expect.any(Object)
    );
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
  });

  it("falls back to 'organizations' when tenantId is empty/undefined", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 1 }),
    });
    await refreshAccessToken({ tenantId: "", refreshToken: "r", clientId: "c", clientSecret: "s" });
    expect(fetch).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
      expect.any(Object)
    );
  });

  it("uses MICROSOFT_OAUTH_BASE_URL when set together with the insecure flag", async () => {
    process.env.MICROSOFT_OAUTH_BASE_URL = "http://graph-mock:9005";
    process.env.PINCHY_INSECURE_MAIL_MOCK = "1";
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 1 }),
    });
    await refreshAccessToken({
      tenantId: "t",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://graph-mock:9005/t/oauth2/v2.0/token",
      expect.any(Object)
    );
  });

  it("ignores MICROSOFT_OAUTH_BASE_URL when the insecure flag is absent", async () => {
    process.env.MICROSOFT_OAUTH_BASE_URL = "http://graph-mock:9005";
    // No PINCHY_INSECURE_MAIL_MOCK. This is the request body that carries the
    // client secret AND the refresh token — the longest-lived credentials
    // Pinchy holds — so a stray override must not redirect it.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 1 }),
    });
    await refreshAccessToken({
      tenantId: "t",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      expect.any(Object)
    );
  });

  it("sends the shared MICROSOFT_OAUTH_SCOPES constant as the scope param, not a byte-copy", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 1 }),
    });
    await refreshAccessToken({
      tenantId: "t",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
    });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(body.get("scope")).toBe(MICROSOFT_OAUTH_SCOPES);
  });

  it("builds the token URL via the descriptor's tokenUrl(), honoring MICROSOFT_OAUTH_BASE_URL", async () => {
    process.env.MICROSOFT_OAUTH_BASE_URL = "";
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 1 }),
    });
    await refreshAccessToken({
      tenantId: "my-tenant",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
    });
    // An explicit empty-string override must behave identically for the
    // token-exchange descriptor and the refresh call (both use `??`, not
    // `||`), so an empty env var doesn't silently split them onto different
    // hosts.
    expect(fetch).toHaveBeenCalledWith(
      OAUTH_PROVIDERS.microsoft.tokenUrl({ tenantId: "my-tenant" }),
      expect.any(Object)
    );
  });

  it("throws on non-ok response with error_description", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error_description: "invalid_grant" }),
    });
    await expect(
      refreshAccessToken({ tenantId: "t", refreshToken: "r", clientId: "c", clientSecret: "s" })
    ).rejects.toThrow("Microsoft token refresh failed: invalid_grant");
  });
});

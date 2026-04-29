import { describe, it, expect, vi } from "vitest";
import { refreshAccessToken, isTokenExpired } from "../google-oauth.js";

describe("isTokenExpired", () => {
  it("returns true if expiresAt is in the past", () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    expect(isTokenExpired(pastDate)).toBe(true);
  });

  it("returns true if expiresAt is within 5-minute buffer", () => {
    const soonDate = new Date(Date.now() + 2 * 60_000).toISOString();
    expect(isTokenExpired(soonDate)).toBe(true);
  });

  it("returns false if expiresAt is well in the future", () => {
    const futureDate = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(isTokenExpired(futureDate)).toBe(false);
  });
});

describe("refreshAccessToken", () => {
  it("calls Google token endpoint and returns new tokens", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "new-access-token",
          expires_in: 3600,
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await refreshAccessToken({
      refreshToken: "refresh-123",
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    expect(result.accessToken).toBe("new-access-token");
    expect(result.expiresAt).toBeDefined();
    // expiresAt should be roughly 1 hour from now
    const expiresAtMs = new Date(result.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThan(Date.now() + 3500 * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" })
    );

    // Verify the body contains correct form params
    const callArgs = mockFetch.mock.calls[0];
    const body = callArgs[1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-123");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");

    vi.unstubAllGlobals();
  });

  it("throws on failed refresh", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "invalid_grant" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      refreshAccessToken({
        refreshToken: "expired-refresh",
        clientId: "client-id",
        clientSecret: "client-secret",
      })
    ).rejects.toThrow("Token refresh failed: invalid_grant");

    vi.unstubAllGlobals();
  });

  it("throws with status code when error response has no error field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      refreshAccessToken({
        refreshToken: "refresh-123",
        clientId: "client-id",
        clientSecret: "client-secret",
      })
    ).rejects.toThrow("Token refresh failed: 500");

    vi.unstubAllGlobals();
  });

  it("throws with status code when error response is not JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json")),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      refreshAccessToken({
        refreshToken: "refresh-123",
        clientId: "client-id",
        clientSecret: "client-secret",
      })
    ).rejects.toThrow("Token refresh failed: 502");

    vi.unstubAllGlobals();
  });
});

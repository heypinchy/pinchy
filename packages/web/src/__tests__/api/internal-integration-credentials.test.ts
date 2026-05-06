import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: "conn-1",
              type: "odoo",
              credentials: "encrypted-blob",
            },
          ]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn().mockReturnValue('{"accessToken":"test-token","refreshToken":"test-refresh"}'),
  encrypt: vi.fn().mockReturnValue("re-encrypted-blob"),
}));

vi.mock("@/lib/integrations/google-oauth", () => ({
  isTokenExpired: vi.fn().mockReturnValue(false),
  refreshAccessToken: vi.fn().mockResolvedValue({
    accessToken: "refreshed-access-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }),
}));

vi.mock("@/lib/integrations/oauth-settings", () => ({
  getOAuthSettings: vi.fn().mockResolvedValue(null),
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { isTokenExpired, refreshAccessToken } from "@/lib/integrations/google-oauth";
import { getOAuthSettings } from "@/lib/integrations/oauth-settings";
import { GET } from "@/app/api/internal/integrations/[connectionId]/credentials/route";

function makeRequest(connectionId: string) {
  return new NextRequest(`http://localhost/api/internal/integrations/${connectionId}/credentials`, {
    method: "GET",
    headers: {
      Authorization: "Bearer test-token",
    },
  });
}

function makeParams(connectionId: string) {
  return { params: Promise.resolve({ connectionId }) };
}

function mockDbSelectResult(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
}

describe("GET /api/internal/integrations/:connectionId/credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    vi.mocked(decrypt).mockReturnValue(
      '{"accessToken":"test-token","refreshToken":"test-refresh"}'
    );
    mockDbSelectResult([
      {
        id: "conn-1",
        type: "odoo",
        status: "active",
        credentials: "encrypted-blob",
      },
    ]);
  });

  it("returns 401 without valid gateway token", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await GET(makeRequest("conn-1"), makeParams("conn-1"));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 404 for non-existent connection", async () => {
    mockDbSelectResult([]);

    const res = await GET(makeRequest("non-existent"), makeParams("non-existent"));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Connection not found");
  });

  it("returns 403 for pending connection", async () => {
    mockDbSelectResult([
      {
        id: "conn-pending",
        type: "google",
        status: "pending",
        credentials: "encrypted-blob",
      },
    ]);

    const res = await GET(makeRequest("conn-pending"), makeParams("conn-pending"));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Connection not active");
  });

  it("returns 500 when decryption fails", async () => {
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error("Decryption failed");
    });

    const res = await GET(makeRequest("conn-1"), makeParams("conn-1"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Failed to decrypt credentials");
  });

  it("returns 200 with decrypted credentials for valid connection", async () => {
    const res = await GET(makeRequest("conn-1"), makeParams("conn-1"));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.type).toBe("odoo");
    expect(data.credentials).toEqual({
      accessToken: "test-token",
      refreshToken: "test-refresh",
    });
    expect(decrypt).toHaveBeenCalledWith("encrypted-blob");
  });

  describe("Google OAuth token refresh", () => {
    beforeEach(() => {
      mockDbSelectResult([
        {
          id: "conn-google",
          type: "google",
          status: "active",
          credentials: "encrypted-google-blob",
        },
      ]);
    });

    it("refreshes expired Google token and returns fresh credentials", async () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      const newExpiresAt = new Date(Date.now() + 3600_000).toISOString();
      vi.mocked(refreshAccessToken).mockResolvedValue({
        accessToken: "refreshed-access-token",
        expiresAt: newExpiresAt,
      });

      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "old-access-token",
          refreshToken: "google-refresh-token",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })
      );

      vi.mocked(getOAuthSettings).mockResolvedValue({
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      });

      const res = await GET(makeRequest("conn-google"), makeParams("conn-google"));
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.type).toBe("google");
      expect(data.credentials.accessToken).toBe("refreshed-access-token");
      expect(data.credentials.expiresAt).toBe(newExpiresAt);

      expect(refreshAccessToken).toHaveBeenCalledWith({
        refreshToken: "google-refresh-token",
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      });

      // Should persist the refreshed token in DB
      expect(encrypt).toHaveBeenCalled();
      expect(db.update).toHaveBeenCalled();
    });

    it("returns existing credentials when Google token is not expired", async () => {
      vi.mocked(isTokenExpired).mockReturnValue(false);
      const futureExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "valid-access-token",
          refreshToken: "google-refresh-token",
          expiresAt: futureExpiry,
        })
      );

      const res = await GET(makeRequest("conn-google"), makeParams("conn-google"));
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.credentials.accessToken).toBe("valid-access-token");
      expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("returns existing credentials when Google OAuth settings are missing (graceful degradation)", async () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      vi.mocked(getOAuthSettings).mockResolvedValue(null);

      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "old-token",
          refreshToken: "refresh-token",
          expiresAt: expiredAt,
        })
      );

      const res = await GET(makeRequest("conn-google"), makeParams("conn-google"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.type).toBe("google");
      expect(data.credentials.accessToken).toBe("old-token");
      expect(data.credentials.expiresAt).toBe(expiredAt);
      expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("returns existing credentials when token refresh fails (graceful degradation)", async () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      vi.mocked(refreshAccessToken).mockRejectedValue(
        new Error("Token refresh failed: invalid_grant")
      );

      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "old-token",
          refreshToken: "refresh-token",
          expiresAt: expiredAt,
        })
      );

      vi.mocked(getOAuthSettings).mockResolvedValue({
        clientId: "client-id",
        clientSecret: "client-secret",
      });

      const res = await GET(makeRequest("conn-google"), makeParams("conn-google"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.type).toBe("google");
      expect(data.credentials.accessToken).toBe("old-token");
      expect(data.credentials.expiresAt).toBe(expiredAt);
    });

    describe("Concurrent refresh (race condition – issue #237)", () => {
      // Without serialization, every concurrent caller fires its own
      // refreshAccessToken with the same refresh token. Google rotates
      // refresh tokens, so all but one call hit invalid_grant and the
      // DB row ends up holding a bundle the provider already invalidated.
      // The fix is an in-process mutex keyed by connectionId.

      beforeEach(() => {
        vi.mocked(isTokenExpired).mockReturnValue(true);
        vi.mocked(decrypt).mockReturnValue(
          JSON.stringify({
            accessToken: "old-token",
            refreshToken: "google-refresh-token",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          })
        );
        vi.mocked(getOAuthSettings).mockResolvedValue({
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
        });
      });

      it("calls refreshAccessToken exactly once when 10 concurrent requests race for an expired token", async () => {
        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>((res) => {
          releaseRefresh = res;
        });
        const newExpiresAt = new Date(Date.now() + 3600_000).toISOString();
        vi.mocked(refreshAccessToken).mockImplementation(async () => {
          await refreshGate;
          return { accessToken: "fresh-token", expiresAt: newExpiresAt };
        });

        const requests = Array.from({ length: 10 }, () =>
          GET(makeRequest("conn-google"), makeParams("conn-google"))
        );

        // Yield repeatedly so every request reaches the refresh path.
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setImmediate(r));
        }

        expect(refreshAccessToken).toHaveBeenCalledTimes(1);

        releaseRefresh();
        const responses = await Promise.all(requests);

        for (const res of responses) {
          expect(res.status).toBe(200);
          const data = await res.json();
          expect(data.credentials.accessToken).toBe("fresh-token");
          expect(data.credentials.expiresAt).toBe(newExpiresAt);
        }

        expect(refreshAccessToken).toHaveBeenCalledTimes(1);
        // The shared refresh result is persisted exactly once.
        expect(db.update).toHaveBeenCalledTimes(1);
      });

      it("releases the lock after a failed refresh so the next caller retries", async () => {
        // First refresh fails, second succeeds. If the lock leaks past
        // the failure, the second caller would either await forever
        // (cached rejected Promise) or skip the refresh attempt.
        vi.mocked(refreshAccessToken)
          .mockRejectedValueOnce(new Error("invalid_grant"))
          .mockResolvedValueOnce({
            accessToken: "second-attempt-token",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          });

        const res1 = await GET(makeRequest("conn-google"), makeParams("conn-google"));
        expect(res1.status).toBe(200);
        const data1 = await res1.json();
        expect(data1.credentials.accessToken).toBe("old-token");

        const res2 = await GET(makeRequest("conn-google"), makeParams("conn-google"));
        expect(res2.status).toBe(200);
        const data2 = await res2.json();
        expect(data2.credentials.accessToken).toBe("second-attempt-token");

        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
      });
    });
  });
});

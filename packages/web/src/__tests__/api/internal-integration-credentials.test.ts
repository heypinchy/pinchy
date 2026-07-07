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
  refreshAccessToken: vi.fn().mockResolvedValue({
    accessToken: "refreshed-access-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }),
}));

vi.mock("@/lib/integrations/microsoft-oauth", () => ({
  refreshAccessToken: vi.fn().mockResolvedValue({
    accessToken: "ms-refreshed-access-token",
    refreshToken: "ms-new-refresh-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }),
}));

// The route imports isTokenExpired once from oauth-token and reuses it for
// both the Google and Microsoft branches (see D14 cleanup). Mock it here
// instead of via the provider-specific modules' re-exports. createRefreshDedup
// is kept as the real implementation (via importOriginal) since both the
// route and microsoft-refresh.ts import it to construct their per-provider
// dedup functions at module load time.
vi.mock("@/lib/integrations/oauth-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/oauth-token")>();
  return {
    ...actual,
    isTokenExpired: vi.fn().mockReturnValue(false),
  };
});

vi.mock("@/lib/integrations/oauth-settings", () => ({
  getOAuthSettings: vi.fn().mockResolvedValue(null),
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { refreshAccessToken } from "@/lib/integrations/google-oauth";
import { refreshAccessToken as refreshMsAccessToken } from "@/lib/integrations/microsoft-oauth";
import { isTokenExpired } from "@/lib/integrations/oauth-token";
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

  it("returns an actionable 404 message when the connection no longer exists", async () => {
    mockDbSelectResult([]);

    const res = await GET(makeRequest("non-existent"), makeParams("non-existent"));
    expect(res.status).toBe(404);
    const data = await res.json();
    // This body.error is surfaced (via the plugins) into the agent's tool error,
    // so a bare "Connection not found" turns into an opaque "technical problem
    // (error 404)" for the user. Make it actionable and generic across providers:
    // say what happened and where an admin fixes it.
    expect(data.error).toMatch(/no longer connected/i);
    expect(data.error).toMatch(/integrations/i);
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

  it("returns non-oauth credentials unchanged even when expiresAt looks expired (dispatch lookup miss, no refresh attempted)", async () => {
    // The refresh dispatch is keyed by connection.type. A type outside the
    // {google, microsoft} lookup must never trigger a refresh -- this pins
    // that the lookup miss behaves exactly like the old per-provider `if`
    // gates that simply didn't match a non-oauth type.
    vi.mocked(isTokenExpired).mockReturnValue(true);
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(decrypt).mockReturnValue(
      JSON.stringify({
        accessToken: "odoo-token",
        refreshToken: "odoo-refresh",
        expiresAt: expiredAt,
      })
    );

    const res = await GET(makeRequest("conn-1"), makeParams("conn-1"));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.type).toBe("odoo");
    expect(data.credentials).toEqual({
      accessToken: "odoo-token",
      refreshToken: "odoo-refresh",
      expiresAt: expiredAt,
    });

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(refreshMsAccessToken).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
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

    it("returns 503 with a structured error when Google OAuth settings are missing for an expired token (no stale credentials leaked)", async () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      vi.mocked(getOAuthSettings).mockResolvedValue(null);

      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "google-stale-access-token",
          refreshToken: "google-stale-refresh-token",
          expiresAt: expiredAt,
        })
      );

      const res = await GET(makeRequest("conn-google"), makeParams("conn-google"));
      expect(res.status).toBe(503);

      const data = await res.json();
      expect(data.error).toBe(
        "Google OAuth settings missing — reconnect the mailbox or restore the OAuth app"
      );
      // Must NOT leak the stale/expired credentials in the response body.
      expect(data.credentials).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("google-stale-access-token");
      expect(JSON.stringify(data)).not.toContain("google-stale-refresh-token");

      // Refresh must not have been attempted (no client credentials available)
      // and the DB must not be touched.
      expect(refreshAccessToken).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
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

  describe("Microsoft credentials refresh", () => {
    beforeEach(() => {
      mockDbSelectResult([
        {
          id: "conn-ms",
          type: "microsoft",
          status: "active",
          credentials: "encrypted-ms-blob",
        },
      ]);
      vi.mocked(isTokenExpired).mockReturnValue(false);
      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "ms-old-access-token",
          refreshToken: "ms-old-refresh-token",
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          scope: "offline_access Mail.ReadWrite",
        })
      );
    });

    it("refreshes when expiresAt is in the buffer and writes BOTH new accessToken AND new refreshToken back", async () => {
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "ms-old-access-token",
          refreshToken: "ms-old-refresh-token",
          expiresAt: expiredAt,
          scope: "offline_access Mail.ReadWrite",
        })
      );
      vi.mocked(isTokenExpired).mockReturnValue(true);

      const newExpiresAt = new Date(Date.now() + 3600_000).toISOString();
      vi.mocked(refreshMsAccessToken).mockResolvedValue({
        accessToken: "ms-new-access-token",
        refreshToken: "ms-rotated-refresh-token",
        expiresAt: newExpiresAt,
      });

      vi.mocked(getOAuthSettings).mockResolvedValue({
        clientId: "ms-client-id",
        clientSecret: "ms-client-secret",
        tenantId: "ms-tenant-id",
      });

      const res = await GET(makeRequest("conn-ms"), makeParams("conn-ms"));
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.type).toBe("microsoft");
      expect(data.credentials.accessToken).toBe("ms-new-access-token");
      expect(data.credentials.refreshToken).toBe("ms-rotated-refresh-token");
      expect(data.credentials.expiresAt).toBe(newExpiresAt);

      expect(refreshMsAccessToken).toHaveBeenCalledWith({
        tenantId: "ms-tenant-id",
        refreshToken: "ms-old-refresh-token",
        clientId: "ms-client-id",
        clientSecret: "ms-client-secret",
      });

      // Must persist BOTH the new accessToken AND new refreshToken (Microsoft rotates refresh tokens)
      expect(encrypt).toHaveBeenCalled();
      const encryptedArg = vi.mocked(encrypt).mock.calls[0][0];
      const persisted = JSON.parse(encryptedArg);
      expect(persisted.accessToken).toBe("ms-new-access-token");
      expect(persisted.refreshToken).toBe("ms-rotated-refresh-token");
      expect(db.update).toHaveBeenCalled();
    });

    it("returns 503 with a structured error when Microsoft OAuth settings are missing for an expired token (no stale credentials leaked)", async () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "ms-stale-access-token",
          refreshToken: "ms-stale-refresh-token",
          expiresAt: expiredAt,
          scope: "offline_access Mail.ReadWrite",
        })
      );
      vi.mocked(getOAuthSettings).mockResolvedValue(null);

      const res = await GET(makeRequest("conn-ms"), makeParams("conn-ms"));
      expect(res.status).toBe(503);

      const data = await res.json();
      expect(data.error).toBe(
        "Microsoft OAuth settings missing — reconnect the mailbox or restore the OAuth app"
      );
      // Must NOT leak the stale/expired credentials in the response body.
      expect(data.credentials).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("ms-stale-access-token");
      expect(JSON.stringify(data)).not.toContain("ms-stale-refresh-token");

      // Refresh must not have been attempted (no client credentials available)
      // and the DB must not be touched.
      expect(refreshMsAccessToken).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it("concurrent requests for the same connectionId share a single refresh (in-flight dedup)", async () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.mocked(decrypt).mockReturnValue(
        JSON.stringify({
          accessToken: "ms-old-access-token",
          refreshToken: "ms-old-refresh-token",
          expiresAt: expiredAt,
        })
      );
      vi.mocked(getOAuthSettings).mockResolvedValue({
        clientId: "ms-client-id",
        clientSecret: "ms-client-secret",
        tenantId: "ms-tenant-id",
      });

      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((res) => {
        releaseRefresh = res;
      });
      const newExpiresAt = new Date(Date.now() + 3600_000).toISOString();
      vi.mocked(refreshMsAccessToken).mockImplementation(async () => {
        await refreshGate;
        return {
          accessToken: "ms-fresh-token",
          refreshToken: "ms-fresh-refresh-token",
          expiresAt: newExpiresAt,
        };
      });

      const requests = Array.from({ length: 10 }, () =>
        GET(makeRequest("conn-ms"), makeParams("conn-ms"))
      );

      // Yield repeatedly so every request reaches the refresh path.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }

      expect(refreshMsAccessToken).toHaveBeenCalledTimes(1);

      releaseRefresh();
      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.credentials.accessToken).toBe("ms-fresh-token");
        expect(data.credentials.refreshToken).toBe("ms-fresh-refresh-token");
      }

      expect(refreshMsAccessToken).toHaveBeenCalledTimes(1);
      // The shared refresh result is persisted exactly once.
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("refresh failure returns the stale credentials (graceful degradation)", async () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      const staleCredentials = {
        accessToken: "ms-stale-access-token",
        refreshToken: "ms-stale-refresh-token",
        expiresAt: expiredAt,
      };
      vi.mocked(decrypt).mockReturnValue(JSON.stringify(staleCredentials));
      vi.mocked(getOAuthSettings).mockResolvedValue({
        clientId: "ms-client-id",
        clientSecret: "ms-client-secret",
        tenantId: "ms-tenant-id",
      });
      vi.mocked(refreshMsAccessToken).mockRejectedValue(
        new Error("Microsoft token refresh failed: invalid_grant")
      );

      const res = await GET(makeRequest("conn-ms"), makeParams("conn-ms"));
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.type).toBe("microsoft");
      expect(data.credentials.accessToken).toBe("ms-stale-access-token");
      expect(data.credentials.refreshToken).toBe("ms-stale-refresh-token");
      expect(data.credentials.expiresAt).toBe(expiredAt);

      // DB should NOT be updated when refresh fails
      expect(db.update).not.toHaveBeenCalled();
    });

    describe("Persist failure after successful rotation (issue #237)", () => {
      // Microsoft rotates the refresh token on every use, so once
      // refreshMsAccessToken succeeds, the OLD refresh token is already dead
      // at the provider. If the DB write that persists the rotated token
      // then fails, the rotated token must not be silently discarded —
      // falling back to "stale" credentials here would mean the DB keeps a
      // refresh token the provider has already burned, permanently bricking
      // the mailbox with invalid_grant until manual reconnect.

      function mockDbUpdateResults(whereResults: Array<() => Promise<unknown>>) {
        const where = vi.fn();
        for (const result of whereResults) {
          where.mockImplementationOnce(result);
        }
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({ where }),
        } as any);
        return where;
      }

      beforeEach(() => {
        vi.mocked(isTokenExpired).mockReturnValue(true);
        const expiredAt = new Date(Date.now() - 60_000).toISOString();
        vi.mocked(decrypt).mockReturnValue(
          JSON.stringify({
            accessToken: "ms-old-access-token",
            refreshToken: "ms-old-refresh-token",
            expiresAt: expiredAt,
            scope: "offline_access Mail.ReadWrite",
          })
        );
        vi.mocked(getOAuthSettings).mockResolvedValue({
          clientId: "ms-client-id",
          clientSecret: "ms-client-secret",
          tenantId: "ms-tenant-id",
        });
        vi.mocked(refreshMsAccessToken).mockResolvedValue({
          accessToken: "ms-rotated-access-token",
          refreshToken: "ms-rotated-refresh-token",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      });

      it("persists the rotated Microsoft refresh token on a retried DB write", async () => {
        const where = mockDbUpdateResults([
          () => Promise.reject(new Error("transient DB error")),
          () => Promise.resolve(undefined),
        ]);

        const res = await GET(makeRequest("conn-ms"), makeParams("conn-ms"));
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.type).toBe("microsoft");
        expect(data.credentials.accessToken).toBe("ms-rotated-access-token");
        expect(data.credentials.refreshToken).toBe("ms-rotated-refresh-token");

        expect(db.update).toHaveBeenCalledTimes(2);
        expect(where).toHaveBeenCalledTimes(2);

        // The retried write must contain the rotated (not stale) refreshToken.
        const secondEncryptedArg = vi.mocked(encrypt).mock.calls[1][0];
        const persisted = JSON.parse(secondEncryptedArg);
        expect(persisted.refreshToken).toBe("ms-rotated-refresh-token");
        expect(persisted.accessToken).toBe("ms-rotated-access-token");
      });

      it("fails the request instead of returning stale credentials when the rotated token cannot be persisted", async () => {
        mockDbUpdateResults([
          () => Promise.reject(new Error("transient DB error")),
          () => Promise.reject(new Error("transient DB error again")),
        ]);

        await expect(GET(makeRequest("conn-ms"), makeParams("conn-ms"))).rejects.toThrow();

        expect(db.update).toHaveBeenCalledTimes(2);

        // There is no generic catch-all in the GET handler for this failure
        // mode, so the route rejects rather than resolving a Response — an
        // unhandled throw becomes a 500 at the framework boundary. That is
        // exactly the point: the alternative (a resolved 200 carrying the
        // stale accessToken/refreshToken) is the bug this test guards
        // against, and asserting `.rejects` proves that path is impossible.
      });
    });
  });
});

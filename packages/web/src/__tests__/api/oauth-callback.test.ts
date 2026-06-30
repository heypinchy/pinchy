import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetSession,
  mockGetOAuthSettings,
  mockEncrypt,
  mockAppendAuditLog,
  mockValues,
  mockSelectLimit,
  mockSelectFrom,
  mockUpdateReturning,
  mockUpdateSet,
  mockDeleteWhere,
} = vi.hoisted(() => {
  const mockSelectLimit = vi.fn();
  const mockSelectWhere = vi.fn().mockReturnValue({ limit: mockSelectLimit });
  const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  return {
    mockGetSession: vi.fn(),
    mockGetOAuthSettings: vi.fn(),
    mockEncrypt: vi.fn().mockReturnValue("encrypted-creds"),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    mockValues: vi.fn(),
    mockSelectLimit,
    mockSelectFrom,
    mockUpdateReturning,
    mockUpdateSet,
    mockDeleteWhere,
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

vi.mock("@/lib/integrations/oauth-settings", () => ({
  getOAuthSettings: (...args: unknown[]) => mockGetOAuthSettings(...args),
}));

vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: vi.fn(),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
  };
});

const mockClearIntegrationAuthError = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/auth-state", () => ({
  clearIntegrationAuthError: (...args: unknown[]) => mockClearIntegrationAuthError(...args),
}));

const mockConnection = {
  id: "conn-new-123",
  type: "google",
  name: "user@gmail.com",
  description: "",
  credentials: "encrypted-creds",
  data: { emailAddress: "user@gmail.com", provider: "gmail" },
  status: "active",
  createdAt: new Date("2026-04-09"),
  updatedAt: new Date("2026-04-09"),
};

const mockPendingConnection = {
  id: "pending-conn-id",
  type: "google",
  name: "Google (connecting…)",
  description: "",
  credentials: "encrypted-empty",
  data: null,
  status: "pending",
  createdAt: new Date("2026-04-09"),
  updatedAt: new Date("2026-04-09"),
};

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: (...args: unknown[]) => mockValues(...args),
    }),
    update: vi.fn().mockReturnValue({ set: mockUpdateSet }),
    select: vi.fn().mockReturnValue({ from: mockSelectFrom }),
    delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id", status: "status" },
}));

// Mock global fetch for token exchange and profile fetching
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET } from "@/app/api/integrations/oauth/callback/route";

const VALID_STATE = "random-state-token-abc123";

function makeRequest(params: Record<string, string> = {}, cookieHeader?: string) {
  const url = new URL("http://localhost:7777/api/integrations/oauth/callback");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {};
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }
  return new Request(url.toString(), { method: "GET", headers });
}

function adminSession() {
  return { user: { id: "admin-1", role: "admin" } };
}

function mockTokenExchange(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      access_token: "ya29.access-token",
      refresh_token: "1//refresh-token",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      ...overrides,
    }),
  };
}

function mockProfileFetch(email = "user@gmail.com") {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ emailAddress: email }),
  };
}

describe("GET /api/integrations/oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00Z"));
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([mockConnection]),
    });
    // Default: select returns no pending record (fallback to INSERT path)
    mockSelectLimit.mockResolvedValue([]);
    mockUpdateReturning.mockResolvedValue([mockConnection]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("redirects with error if not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await GET(makeRequest({ code: "abc", state: VALID_STATE }));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/settings");
    expect(location.searchParams.get("tab")).toBe("integrations");
    expect(location.searchParams.get("error")).toBe("unauthorized");
  });

  it("redirects with error if user is not admin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "user" } });

    const response = await GET(makeRequest({ code: "abc", state: VALID_STATE }));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("unauthorized");
  });

  it("redirects with error if code is missing", async () => {
    mockGetSession.mockResolvedValue(adminSession());

    const response = await GET(makeRequest({ state: VALID_STATE }));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("missing_params");
  });

  it("redirects with error if state is missing", async () => {
    mockGetSession.mockResolvedValue(adminSession());

    const response = await GET(makeRequest({ code: "abc" }));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("missing_params");
  });

  it("redirects with error if state does not match cookie (CSRF)", async () => {
    mockGetSession.mockResolvedValue(adminSession());

    const response = await GET(
      makeRequest({ code: "abc", state: "attacker-state" }, `oauth_state=${VALID_STATE}`)
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("state_mismatch");
  });

  it("redirects with error if oauth_state cookie is missing", async () => {
    mockGetSession.mockResolvedValue(adminSession());

    const response = await GET(
      makeRequest({ code: "abc", state: VALID_STATE })
      // no cookie
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("state_mismatch");
  });

  it("redirects with error if Google OAuth is not configured", async () => {
    mockGetSession.mockResolvedValue(adminSession());
    mockGetOAuthSettings.mockResolvedValue(null);

    const response = await GET(
      makeRequest({ code: "abc", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("not_configured");
  });

  it("redirects with error if token exchange fails", async () => {
    mockGetSession.mockResolvedValue(adminSession());
    mockGetOAuthSettings.mockResolvedValue({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: "invalid_grant" }),
    });

    const response = await GET(
      makeRequest({ code: "bad-code", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("token_exchange_failed");
  });

  it("logs audit failure when token exchange fails", async () => {
    mockGetSession.mockResolvedValue(adminSession());
    mockGetOAuthSettings.mockResolvedValue({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: "invalid_grant" }),
    });

    await GET(makeRequest({ code: "bad-code", state: VALID_STATE }, `oauth_state=${VALID_STATE}`));

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        outcome: "failure",
      })
    );
  });

  it("redirects with error if profile fetch fails", async () => {
    mockGetSession.mockResolvedValue(adminSession());
    mockGetOAuthSettings.mockResolvedValue({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
    mockFetch
      .mockResolvedValueOnce(mockTokenExchange())
      .mockResolvedValueOnce({ ok: false, json: vi.fn().mockResolvedValue({}) });

    const response = await GET(
      makeRequest({ code: "valid-code", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("profile_fetch_failed");
  });

  it("logs audit failure when profile fetch fails", async () => {
    mockGetSession.mockResolvedValue(adminSession());
    mockGetOAuthSettings.mockResolvedValue({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
    mockFetch
      .mockResolvedValueOnce(mockTokenExchange())
      .mockResolvedValueOnce({ ok: false, json: vi.fn().mockResolvedValue({}) });

    await GET(
      makeRequest({ code: "valid-code", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
    );

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        outcome: "failure",
      })
    );
  });

  describe("successful flow — without oauth_pending_id cookie (INSERT fallback)", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue(adminSession());
      mockGetOAuthSettings.mockResolvedValue({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
      mockFetch
        .mockResolvedValueOnce(mockTokenExchange())
        .mockResolvedValueOnce(mockProfileFetch());
    });

    it("exchanges code for tokens with correct parameters", async () => {
      await GET(
        makeRequest({ code: "auth-code-123", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://oauth2.googleapis.com/token",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        })
      );

      // Verify the body contains correct params
      const callArgs = mockFetch.mock.calls[0];
      const body = new URLSearchParams(callArgs[1].body);
      expect(body.get("code")).toBe("auth-code-123");
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
      expect(body.get("redirect_uri")).toBe(
        "http://localhost:7777/api/integrations/oauth/callback"
      );
      expect(body.get("grant_type")).toBe("authorization_code");
    });

    it("fetches Gmail profile with access token", async () => {
      await GET(
        makeRequest({ code: "auth-code-123", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://www.googleapis.com/gmail/v1/users/me/profile",
        expect.objectContaining({
          headers: { Authorization: "Bearer ya29.access-token" },
        })
      );
    });

    it("inserts new connection with encrypted credentials", async () => {
      await GET(
        makeRequest({ code: "auth-code-123", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
      );

      expect(mockEncrypt).toHaveBeenCalledWith(
        JSON.stringify({
          accessToken: "ya29.access-token",
          refreshToken: "1//refresh-token",
          expiresAt: "2026-04-09T13:00:00.000Z", // 3600s after fake now
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        })
      );

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "google",
          name: "user@gmail.com",
          credentials: "encrypted-creds",
          data: expect.objectContaining({
            emailAddress: "user@gmail.com",
            provider: "gmail",
          }),
        })
      );
    });

    it("calls appendAuditLog with redacted email (no plaintext PII per GDPR Art. 17)", async () => {
      vi.stubEnv("AUDIT_HMAC_SECRET", "f".repeat(64));
      await GET(
        makeRequest({ code: "auth-code-123", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
      );

      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "user",
        actorId: "admin-1",
        eventType: "integration.created",
        resource: `integration:${mockConnection.id}`,
        detail: {
          type: "google",
          emailHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          emailPreview: "user@gmail.com",
        },
        outcome: "success",
      });

      // The fields that previously carried plaintext PII must not exist.
      // Note: for short local parts (≤4 chars) the emailPreview legitimately
      // equals the raw address per redactEmail's spec — the hash still
      // provides one-way protection. See docs/concepts/audit-trail.mdx.
      const detail = mockAppendAuditLog.mock.calls[0][0].detail;
      expect(detail).not.toHaveProperty("emailAddress");
      expect(detail).not.toHaveProperty("name");
    });

    it("deletes oauth_state cookie", async () => {
      const response = await GET(
        makeRequest({ code: "auth-code-123", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
      );

      const setCookie = response.headers.get("Set-Cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toMatch(/oauth_state=/);
      expect(setCookie).toMatch(/Max-Age=0/);
    });

    it("cookie cleanup sets Secure and SameSite=Lax on HTTPS", async () => {
      const response = await GET(
        new Request(
          `https://pinchy.example.com/api/integrations/oauth/callback?code=auth-code-123&state=${VALID_STATE}`,
          { headers: { Cookie: `oauth_state=${VALID_STATE}` } }
        )
      );

      const setCookieHeaders = response.headers.getSetCookie
        ? response.headers.getSetCookie()
        : [response.headers.get("Set-Cookie") ?? ""];
      const allCookies = setCookieHeaders.join("; ");
      expect(allCookies).toMatch(/Secure/i);
      expect(allCookies).toMatch(/SameSite=Lax/i);
    });

    it("redirects to settings with created connection id", async () => {
      const response = await GET(
        makeRequest({ code: "auth-code-123", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.pathname).toBe("/settings");
      expect(location.searchParams.get("tab")).toBe("integrations");
      expect(location.searchParams.get("created")).toBe(mockConnection.id);
    });
  });

  describe("successful flow — with oauth_pending_id cookie (UPDATE path)", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue(adminSession());
      mockGetOAuthSettings.mockResolvedValue({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
      mockFetch
        .mockResolvedValueOnce(mockTokenExchange())
        .mockResolvedValueOnce(mockProfileFetch());
      // Select finds the pending record
      mockSelectLimit.mockResolvedValue([mockPendingConnection]);
    });

    it("updates existing pending record instead of inserting a new one", async () => {
      await GET(
        makeRequest(
          { code: "auth-code-123", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=pending-conn-id`
        )
      );

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "user@gmail.com",
          status: "active",
          credentials: "encrypted-creds",
          data: expect.objectContaining({
            emailAddress: "user@gmail.com",
            provider: "gmail",
          }),
        })
      );
      // INSERT should NOT have been called
      expect(mockValues).not.toHaveBeenCalled();
    });

    it("deletes oauth_pending_id cookie after successful update", async () => {
      const response = await GET(
        makeRequest(
          { code: "auth-code-123", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=pending-conn-id`
        )
      );

      const setCookieHeader = response.headers.getSetCookie
        ? response.headers.getSetCookie().join("; ")
        : (response.headers.get("Set-Cookie") ?? "");
      expect(setCookieHeader).toMatch(/oauth_pending_id=/);
      expect(setCookieHeader).toMatch(/Max-Age=0/);
    });

    it("redirects to settings with updated connection id", async () => {
      const response = await GET(
        makeRequest(
          { code: "auth-code-123", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=pending-conn-id`
        )
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.searchParams.get("created")).toBe(mockConnection.id);
    });
  });

  describe("Microsoft callback", () => {
    const mockMsPendingConnection = {
      id: "ms-pending-conn-id",
      type: "microsoft",
      name: "Microsoft (connecting…)",
      description: "",
      credentials: "encrypted-empty",
      data: null,
      status: "pending",
      createdAt: new Date("2026-04-09"),
      updatedAt: new Date("2026-04-09"),
    };

    const mockMsConnection = {
      id: "ms-conn-123",
      type: "microsoft",
      name: "user@contoso.com",
      description: "",
      credentials: "encrypted-creds",
      data: { emailAddress: "user@contoso.com", provider: "outlook" },
      status: "active",
      createdAt: new Date("2026-04-09"),
      updatedAt: new Date("2026-04-09"),
    };

    function mockMsTokenExchange(overrides: Record<string, unknown> = {}) {
      return {
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "ms-access-token",
          refresh_token: "ms-refresh-token",
          expires_in: 3600,
          scope: "offline_access User.Read Mail.ReadWrite Mail.Send",
          ...overrides,
        }),
      };
    }

    function mockMsProfileFetch(profile: Record<string, unknown> = {}) {
      return {
        ok: true,
        json: vi.fn().mockResolvedValue({
          mail: "user@contoso.com",
          userPrincipalName: "user@contoso.com",
          ...profile,
        }),
      };
    }

    beforeEach(() => {
      mockGetSession.mockResolvedValue(adminSession());
      mockGetOAuthSettings.mockResolvedValue({
        clientId: "ms-client-id",
        clientSecret: "ms-client-secret",
        tenantId: "my-tenant",
      });
      mockSelectLimit.mockResolvedValue([mockMsPendingConnection]);
      mockUpdateReturning.mockResolvedValue([mockMsConnection]);
    });

    it("exchanges code at login.microsoftonline.com/<tenant>/oauth2/v2.0/token", async () => {
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(mockMsProfileFetch());

      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      expect(mockGetOAuthSettings).toHaveBeenCalledWith("microsoft");

      const tokenCall = mockFetch.mock.calls[0];
      expect(tokenCall[0]).toBe("https://login.microsoftonline.com/my-tenant/oauth2/v2.0/token");
      expect(tokenCall[1]).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const body = new URLSearchParams(tokenCall[1].body);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("ms-auth-code");
      expect(body.get("client_id")).toBe("ms-client-id");
      expect(body.get("client_secret")).toBe("ms-client-secret");
      expect(body.get("redirect_uri")).toBe(
        "http://localhost:7777/api/integrations/oauth/callback"
      );
    });

    it("uses MICROSOFT_OAUTH_BASE_URL env override for token endpoint", async () => {
      vi.stubEnv("MICROSOFT_OAUTH_BASE_URL", "https://mock-ms-auth.local");
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(mockMsProfileFetch());

      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      const tokenCall = mockFetch.mock.calls[0];
      expect(tokenCall[0]).toBe("https://mock-ms-auth.local/my-tenant/oauth2/v2.0/token");
      vi.unstubAllEnvs();
    });

    it("defaults to tenantId='organizations' when tenantId is missing", async () => {
      mockGetOAuthSettings.mockResolvedValue({
        clientId: "ms-client-id",
        clientSecret: "ms-client-secret",
      });
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(mockMsProfileFetch());

      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      const tokenCall = mockFetch.mock.calls[0];
      expect(tokenCall[0]).toBe(
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
      );
    });

    it("fetches /v1.0/me and uses mail as email address", async () => {
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(mockMsProfileFetch({ mail: "user@contoso.com" }));

      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      const profileCall = mockFetch.mock.calls[1];
      expect(profileCall[0]).toContain("/v1.0/me");
      expect(profileCall[1]).toMatchObject({
        headers: { Authorization: "Bearer ms-access-token" },
      });
    });

    it("falls back to userPrincipalName when mail is null", async () => {
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(
          mockMsProfileFetch({ mail: null, userPrincipalName: "upn@contoso.com" })
        );

      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ name: "upn@contoso.com" })
      );
    });

    it("persists accessToken, refreshToken, expiresAt, scope", async () => {
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(mockMsProfileFetch());

      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      expect(mockEncrypt).toHaveBeenCalledWith(
        JSON.stringify({
          accessToken: "ms-access-token",
          refreshToken: "ms-refresh-token",
          expiresAt: "2026-04-09T13:00:00.000Z",
          scope: "offline_access User.Read Mail.ReadWrite Mail.Send",
        })
      );
    });

    it("stores provider='outlook' in data blob", async () => {
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(mockMsProfileFetch());

      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            emailAddress: "user@contoso.com",
            provider: "outlook",
          }),
        })
      );
    });

    it("writes audit log with redacted email (no plaintext email in detail)", async () => {
      vi.stubEnv("AUDIT_HMAC_SECRET", "f".repeat(64));
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(mockMsProfileFetch());

      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: "admin-1",
          resource: `integration:${mockMsConnection.id}`,
          outcome: "success",
          detail: expect.objectContaining({
            action: "integration_created",
            type: "microsoft",
          }),
        })
      );

      const detail = mockAppendAuditLog.mock.calls[0][0].detail;
      expect(detail).not.toHaveProperty("emailAddress");
      expect(detail).toHaveProperty("emailHash");
    });

    it("failure: token_exchange_failed uses resource 'integration:microsoft'", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: "invalid_grant" }),
      });

      await GET(
        makeRequest(
          { code: "bad-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "integration:microsoft",
          outcome: "failure",
          detail: expect.objectContaining({
            action: "integration_oauth_failed",
            type: "microsoft",
          }),
        })
      );
    });

    it("redirects to settings with created connection id on success", async () => {
      mockFetch
        .mockResolvedValueOnce(mockMsTokenExchange())
        .mockResolvedValueOnce(mockMsProfileFetch());

      const response = await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=ms-pending-conn-id`
        )
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.pathname).toBe("/settings");
      expect(location.searchParams.get("tab")).toBe("integrations");
      expect(location.searchParams.get("created")).toBe(mockMsConnection.id);
    });
  });

  describe("successful flow — oauth_pending_id points to non-existent record (INSERT fallback)", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue(adminSession());
      mockGetOAuthSettings.mockResolvedValue({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
      mockFetch
        .mockResolvedValueOnce(mockTokenExchange())
        .mockResolvedValueOnce(mockProfileFetch());
      // Select returns empty (record not found / already active)
      mockSelectLimit.mockResolvedValue([]);
    });

    it("falls back to INSERT when pending record not found", async () => {
      await GET(
        makeRequest(
          { code: "auth-code-123", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=stale-id`
        )
      );

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "google",
          name: "user@gmail.com",
        })
      );
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });
  });

  describe("Microsoft — oauth_pending_id points to non-existent record (INSERT fallback with oauth_provider cookie)", () => {
    const mockMsConnection = {
      id: "ms-conn-fallback-123",
      type: "microsoft",
      name: "user@contoso.com",
      description: "",
      credentials: "encrypted-creds",
      data: { emailAddress: "user@contoso.com", provider: "outlook" },
      status: "active",
      createdAt: new Date("2026-04-09"),
      updatedAt: new Date("2026-04-09"),
    };

    beforeEach(() => {
      mockGetSession.mockResolvedValue(adminSession());
      mockGetOAuthSettings.mockResolvedValue({
        clientId: "ms-client-id",
        clientSecret: "ms-client-secret",
        tenantId: "my-tenant",
      });
      // Pending record is gone — select returns nothing
      mockSelectLimit.mockResolvedValue([]);
      mockValues.mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockMsConnection]),
      });
      // Microsoft token exchange + profile fetch
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            access_token: "ms-access-token",
            refresh_token: "ms-refresh-token",
            expires_in: 3600,
            scope: "offline_access User.Read Mail.ReadWrite Mail.Send",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            mail: "user@contoso.com",
            userPrincipalName: "user@contoso.com",
          }),
        });
    });

    it("inserts with type='microsoft' when oauth_provider=microsoft cookie is set and pending record is gone", async () => {
      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_pending_id=stale-ms-id; oauth_provider=microsoft`
        )
      );

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "microsoft",
          name: "user@contoso.com",
        })
      );
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it("inserts with type='microsoft' when no oauth_pending_id cookie but oauth_provider=microsoft is set", async () => {
      // No oauth_pending_id cookie at all — exercises the else branch that falls
      // back to the oauth_provider cookie directly without doing a DB lookup.
      await GET(
        makeRequest(
          { code: "ms-auth-code", state: VALID_STATE },
          `oauth_state=${VALID_STATE}; oauth_provider=microsoft`
        )
      );

      // No pending-record lookup should have happened
      expect(mockSelectLimit).not.toHaveBeenCalled();

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "microsoft",
          name: "user@contoso.com",
        })
      );
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });
  });

  describe("reconnect flow — state.reconnectConnectionId is set", () => {
    // Build a state param that encodes reconnectConnectionId (as POST /oauth/start would)
    function buildReconnectState(reconnectConnectionId: string) {
      const stateObj = {
        nonce: "test-nonce-abc123",
        reconnectConnectionId,
      };
      return Buffer.from(JSON.stringify(stateObj)).toString("base64url");
    }

    const RECONNECT_STATE = buildReconnectState("existing-conn-id");

    beforeEach(() => {
      mockGetSession.mockResolvedValue(adminSession());
      mockGetOAuthSettings.mockResolvedValue({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
      mockFetch
        .mockResolvedValueOnce(mockTokenExchange())
        .mockResolvedValueOnce(mockProfileFetch());
      mockUpdateReturning.mockResolvedValue([{ ...mockConnection, id: "existing-conn-id" }]);
    });

    it("updates existing row instead of inserting a new one", async () => {
      await GET(
        makeRequest(
          { code: "auth-code-123", state: RECONNECT_STATE },
          `oauth_state=${RECONNECT_STATE}`
        )
      );

      // Should update credentials only — status/lastError/lastErrorAt are
      // handled by clearIntegrationAuthError so it can write integration.auth_recovered
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: "encrypted-creds",
        })
      );
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.not.objectContaining({
          status: expect.anything(),
          lastError: expect.anything(),
          lastErrorAt: expect.anything(),
        })
      );
      expect(mockValues).not.toHaveBeenCalled();
    });

    it("calls clearIntegrationAuthError after updating credentials", async () => {
      await GET(
        makeRequest(
          { code: "auth-code-123", state: RECONNECT_STATE },
          `oauth_state=${RECONNECT_STATE}`
        )
      );

      expect(mockClearIntegrationAuthError).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "existing-conn-id" })
      );
    });

    it("writes integration.credentials_updated audit log", async () => {
      vi.stubEnv("AUDIT_HMAC_SECRET", "f".repeat(64));
      await GET(
        makeRequest(
          { code: "auth-code-123", state: RECONNECT_STATE },
          `oauth_state=${RECONNECT_STATE}`
        )
      );

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: "admin-1",
          eventType: "integration.credentials_updated",
          resource: "integration:existing-conn-id",
          outcome: "success",
          detail: expect.objectContaining({ fields: ["oauth_tokens"] }),
        })
      );
    });

    it("does not set oauth_pending_id cookie (no pending row created)", async () => {
      const response = await GET(
        makeRequest(
          { code: "auth-code-123", state: RECONNECT_STATE },
          `oauth_state=${RECONNECT_STATE}`
        )
      );

      const setCookies = response.headers.getSetCookie
        ? response.headers.getSetCookie().join("; ")
        : (response.headers.get("Set-Cookie") ?? "");
      // oauth_pending_id should not appear or should be empty/max-age=0
      expect(setCookies).not.toMatch(/oauth_pending_id=[^;]+(?!Max-Age=0)/);
    });

    it("redirects to settings with the reconnected connection id", async () => {
      const response = await GET(
        makeRequest(
          { code: "auth-code-123", state: RECONNECT_STATE },
          `oauth_state=${RECONNECT_STATE}`
        )
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.searchParams.get("tab")).toBe("integrations");
      expect(location.searchParams.get("created")).toBe("existing-conn-id");
    });

    it("redirects with error if the connection was deleted before callback", async () => {
      // UPDATE returns empty array — connection was deleted between OAuth start and callback
      mockUpdateReturning.mockResolvedValue([]);

      const response = await GET(
        makeRequest(
          { code: "auth-code-123", state: RECONNECT_STATE },
          `oauth_state=${RECONNECT_STATE}`
        )
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.pathname).toBe("/settings");
      expect(location.searchParams.get("tab")).toBe("integrations");
      expect(location.searchParams.get("error")).toBe("connection_not_found");
      // clearIntegrationAuthError must NOT be called when connection is gone
      expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
    });
  });
});

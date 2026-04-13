import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockGetOAuthSettings = vi.fn();
vi.mock("@/lib/integrations/oauth-settings", () => ({
  getOAuthSettings: (...args: unknown[]) => mockGetOAuthSettings(...args),
}));

const mockEncrypt = vi.fn().mockReturnValue("encrypted-creds");
vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: vi.fn(),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

const mockConnection = {
  id: "conn-new-123",
  type: "google",
  name: "user@gmail.com",
  description: "",
  credentials: "encrypted-creds",
  data: { emailAddress: "user@gmail.com", provider: "gmail" },
  createdAt: new Date("2026-04-09"),
  updatedAt: new Date("2026-04-09"),
};

const mockValues = vi.fn();
vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: (...args: unknown[]) => mockValues(...args),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
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

  describe("successful flow", () => {
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

    it("creates connection with encrypted credentials", async () => {
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

    it("calls appendAuditLog with correct payload", async () => {
      await GET(
        makeRequest({ code: "auth-code-123", state: VALID_STATE }, `oauth_state=${VALID_STATE}`)
      );

      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.changed",
        resource: `integration:${mockConnection.id}`,
        detail: {
          action: "integration_created",
          type: "google",
          name: "user@gmail.com",
          emailAddress: "user@gmail.com",
        },
        outcome: "success",
      });
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
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockGetOAuthSettings = vi.fn();
vi.mock("@/lib/integrations/oauth-settings", () => ({
  getOAuthSettings: (...args: unknown[]) => mockGetOAuthSettings(...args),
}));

const mockEncrypt = vi.fn().mockReturnValue("encrypted-placeholder");
vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

const { mockInsertValues, mockDeleteWhere, mockSelectLimit, mockSelectFrom } = vi.hoisted(() => {
  const mockSelectLimit = vi.fn();
  const mockSelectWhere = vi.fn().mockReturnValue({ limit: mockSelectLimit });
  const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
  return {
    mockInsertValues: vi.fn(),
    mockDeleteWhere: vi.fn(),
    mockSelectLimit,
    mockSelectFrom,
  };
});

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: mockInsertValues.mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "pending-conn-id" }]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: mockDeleteWhere.mockResolvedValue(undefined),
    }),
    select: vi.fn().mockReturnValue({ from: mockSelectFrom }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id", type: "type", status: "status" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));

import { NextRequest } from "next/server";

function makeRequest(
  url = "https://local.heypinchy.com:8443/api/integrations/oauth/start",
  cookies?: Record<string, string>
) {
  const headers: Record<string, string> = {};
  if (cookies) {
    headers["Cookie"] = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  return new NextRequest(url, { headers });
}

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };
const oauthSettings = { clientId: "client-id-123", clientSecret: "secret-abc" };

describe("GET /api/integrations/oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockGetOAuthSettings.mockResolvedValue(oauthSettings);
  });

  it("redirects to /settings with unauthorized error when not authenticated", async () => {
    // Browser-driven endpoint: auth failures must redirect, not return JSON,
    // so the user lands somewhere meaningful instead of seeing raw JSON.
    mockGetSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/settings");
    expect(location).toContain("error=unauthorized");
  });

  it("redirects to /settings with unauthorized error when not admin", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-2", role: "member" } });
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/settings");
    expect(location).toContain("error=unauthorized");
  });

  it("redirects to /settings with not_configured error when OAuth not configured", async () => {
    mockGetOAuthSettings.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/settings");
    expect(location).toContain("error=not_configured");
  });

  it("deletes the user's previous pending record when oauth_pending_id cookie is present", async () => {
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    await GET(makeRequest(undefined, { oauth_pending_id: "previous-pending-id" }));
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it("does not delete any records when no previous oauth_pending_id cookie is present", async () => {
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    await GET(makeRequest());
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it("creates a pending integration_connections record", async () => {
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    await GET(makeRequest());
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "google",
        status: "pending",
        name: "Google (connecting\u2026)",
      })
    );
  });

  it("sets oauth_pending_id cookie with the pending record id", async () => {
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("oauth_pending_id=pending-conn-id");
  });

  it("sets oauth_state cookie for CSRF protection", async () => {
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("oauth_state=");
  });

  it("redirects to Google OAuth URL", async () => {
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("accounts.google.com");
    expect(location).toContain("client_id=client-id-123");
  });

  it("uses X-Forwarded-Proto and X-Forwarded-Host for redirect_uri when behind a reverse proxy", async () => {
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const req = new NextRequest("http://localhost:7777/api/integrations/oauth/start", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "local.heypinchy.com:8443",
      },
    });
    const res = await GET(req);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const redirectUri = new URL(location).searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://local.heypinchy.com:8443/api/integrations/oauth/callback");
  });

  it("falls back to request origin when no forwarded headers present", async () => {
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest("https://pinchy.example.com/api/integrations/oauth/start"));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const redirectUri = new URL(location).searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://pinchy.example.com/api/integrations/oauth/callback");
  });

  describe("Microsoft provider (?provider=microsoft)", () => {
    const microsoftSettings = {
      clientId: "ms-client-id",
      clientSecret: "ms-client-secret",
      tenantId: "my-tenant",
    };

    function makeMicrosoftRequest(tenantId?: string) {
      const settings = tenantId
        ? { ...microsoftSettings, tenantId }
        : { clientId: microsoftSettings.clientId, clientSecret: microsoftSettings.clientSecret };
      mockGetOAuthSettings.mockImplementation((provider: string) => {
        if (provider === "microsoft") return Promise.resolve(settings);
        return Promise.resolve(null);
      });
      return new NextRequest(
        "https://local.heypinchy.com:8443/api/integrations/oauth/start?provider=microsoft"
      );
    }

    it("redirects to login.microsoftonline.com with tenant from settings", async () => {
      const { GET } = await import("@/app/api/integrations/oauth/start/route");
      const res = await GET(makeMicrosoftRequest("my-tenant"));
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      const locationUrl = new URL(location);
      expect(locationUrl.host).toBe("login.microsoftonline.com");
      expect(locationUrl.pathname).toBe("/my-tenant/oauth2/v2.0/authorize");
    });

    it("tenant defaults to 'organizations' when tenantId is omitted", async () => {
      const { GET } = await import("@/app/api/integrations/oauth/start/route");
      const res = await GET(makeMicrosoftRequest(undefined));
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      const locationUrl = new URL(location);
      expect(locationUrl.host).toBe("login.microsoftonline.com");
      expect(locationUrl.pathname).toBe("/organizations/oauth2/v2.0/authorize");
    });

    it("scope contains Mail.ReadWrite and offline_access", async () => {
      const { GET } = await import("@/app/api/integrations/oauth/start/route");
      const res = await GET(makeMicrosoftRequest("my-tenant"));
      const location = res.headers.get("location") ?? "";
      const scope = new URL(location).searchParams.get("scope") ?? "";
      expect(scope).toContain("Mail.ReadWrite");
      expect(scope).toContain("offline_access");
    });

    it("pending connection row is created with type='microsoft'", async () => {
      const { GET } = await import("@/app/api/integrations/oauth/start/route");
      await GET(makeMicrosoftRequest("my-tenant"));
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "microsoft",
          status: "pending",
        })
      );
    });
  });

  it("default behaviour (no provider param) still produces a Google flow", async () => {
    mockGetOAuthSettings.mockResolvedValue(oauthSettings);
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(new URL(location).host).toBe("accounts.google.com");
  });
});

describe("POST /api/integrations/oauth/start (reconnect)", () => {
  function makePostRequest(
    body: unknown,
    url = "https://local.heypinchy.com:8443/api/integrations/oauth/start"
  ) {
    return new NextRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };
  const oauthSettings = { clientId: "client-id-123", clientSecret: "secret-abc" };

  const mockGoogleConnection = {
    id: "c1",
    type: "google",
    name: "user@gmail.com",
    status: "auth_failed",
  };

  const mockOdooConnection = {
    id: "c1",
    type: "odoo",
    name: "Odoo connection",
    status: "auth_failed",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockGetOAuthSettings.mockResolvedValue(oauthSettings);
    // Default: select returns the google connection
    mockSelectLimit.mockResolvedValue([mockGoogleConnection]);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/oauth/start/route");
    const res = await POST(makePostRequest({ reconnectConnectionId: "c1" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when not admin", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-2", role: "member" } });
    const { POST } = await import("@/app/api/integrations/oauth/start/route");
    const res = await POST(makePostRequest({ reconnectConnectionId: "c1" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when reconnectConnectionId is missing", async () => {
    const { POST } = await import("@/app/api/integrations/oauth/start/route");
    const res = await POST(makePostRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 404 when connection does not exist", async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    const { POST } = await import("@/app/api/integrations/oauth/start/route");
    const res = await POST(makePostRequest({ reconnectConnectionId: "nonexistent" }));
    expect(res.status).toBe(404);
  });

  it("returns 400 when connection is not google type", async () => {
    mockSelectLimit.mockResolvedValueOnce([mockOdooConnection]);
    const { POST } = await import("@/app/api/integrations/oauth/start/route");
    const res = await POST(makePostRequest({ reconnectConnectionId: "c1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/google/i);
  });

  it("encodes reconnectConnectionId into state when connection exists and is google type", async () => {
    const { POST } = await import("@/app/api/integrations/oauth/start/route");
    const res = await POST(makePostRequest({ reconnectConnectionId: "c1" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.url).toContain("accounts.google.com");

    // The state param should decode to an object containing reconnectConnectionId
    const authUrl = new URL(body.url);
    const stateParam = authUrl.searchParams.get("state");
    expect(stateParam).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(stateParam!, "base64url").toString("utf-8"));
    expect(decoded).toMatchObject({ reconnectConnectionId: "c1" });
  });

  it("sets oauth_state cookie with the encoded state for CSRF", async () => {
    const { POST } = await import("@/app/api/integrations/oauth/start/route");
    const res = await POST(makePostRequest({ reconnectConnectionId: "c1" }));
    const body = await res.json();
    const authUrl = new URL(body.url);
    const stateParam = authUrl.searchParams.get("state")!;

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`oauth_state=${stateParam}`);
  });

  it("returns 400 when OAuth is not configured", async () => {
    mockGetOAuthSettings.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/oauth/start/route");
    const res = await POST(makePostRequest({ reconnectConnectionId: "c1" }));
    expect(res.status).toBe(400);
  });
});

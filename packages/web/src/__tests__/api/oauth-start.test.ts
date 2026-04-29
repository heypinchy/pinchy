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

const { mockInsertValues, mockDeleteWhere } = vi.hoisted(() => ({
  mockInsertValues: vi.fn(),
  mockDeleteWhere: vi.fn(),
}));

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

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 403 when not admin", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-2", role: "member" } });
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it("returns 400 when OAuth not configured", async () => {
    mockGetOAuthSettings.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/integrations/oauth/start/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
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
});

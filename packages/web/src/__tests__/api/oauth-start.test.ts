import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { GET } from "@/app/api/integrations/oauth/start/route";

function makeRequest(url = "http://localhost:7777/api/integrations/oauth/start") {
  return new Request(url, { method: "GET" });
}

describe("GET /api/integrations/oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 if not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("returns 401 if user is not admin", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", role: "user" },
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/admin/i);
  });

  it("returns 400 if Google OAuth is not configured", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
    });
    mockGetOAuthSettings.mockResolvedValue(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/not configured/i);
  });

  it("redirects to Google OAuth URL with correct parameters", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
    });
    mockGetOAuthSettings.mockResolvedValue({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(302);

    const location = response.headers.get("Location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe("https://accounts.google.com");
    expect(redirectUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(redirectUrl.searchParams.get("client_id")).toBe("test-client-id");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:7777/api/integrations/oauth/callback"
    );
    expect(redirectUrl.searchParams.get("response_type")).toBe("code");
    expect(redirectUrl.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email"
    );
    expect(redirectUrl.searchParams.get("access_type")).toBe("offline");
    expect(redirectUrl.searchParams.get("prompt")).toBe("consent");
    expect(redirectUrl.searchParams.get("state")).toBeTruthy();
  });

  it("stores state in an HttpOnly cookie", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
    });
    mockGetOAuthSettings.mockResolvedValue({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });

    const response = await GET(makeRequest());

    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/oauth_state=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=600/);

    // The cookie value should match the state parameter in the redirect URL
    const location = response.headers.get("Location")!;
    const redirectUrl = new URL(location);
    const stateParam = redirectUrl.searchParams.get("state");

    const cookieValue = setCookie!.match(/oauth_state=([^;]+)/)?.[1];
    expect(cookieValue).toBe(stateParam);
  });

  it("calls getOAuthSettings with 'google'", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
    });
    mockGetOAuthSettings.mockResolvedValue(null);

    await GET(makeRequest());

    expect(mockGetOAuthSettings).toHaveBeenCalledWith("google");
  });
});

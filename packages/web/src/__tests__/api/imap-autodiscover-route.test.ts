import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

import { NextRequest } from "next/server";

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };
const nonAdminSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

function makeRequest(query?: string) {
  const url = query
    ? `http://localhost:7777/api/integrations/imap/autodiscover?${query}`
    : "http://localhost:7777/api/integrations/imap/autodiscover";
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/integrations/imap/autodiscover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);

    const { GET } = await import("@/app/api/integrations/imap/autodiscover/route");
    const response = await GET(makeRequest("email=someone@gmail.com"));

    expect(response.status).toBe(401);
  });

  it("returns 403 for a non-admin session", async () => {
    mockGetSession.mockResolvedValue(nonAdminSession);

    const { GET } = await import("@/app/api/integrations/imap/autodiscover/route");
    const response = await GET(makeRequest("email=someone@gmail.com"));

    expect(response.status).toBe(403);
  });

  describe("as admin", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue(adminSession);
    });

    it("returns the bundled provider-table config for a known provider email", async () => {
      const { GET } = await import("@/app/api/integrations/imap/autodiscover/route");
      const response = await GET(makeRequest("email=someone@gmail.com"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.source).toBe("provider-table");
      expect(body.config).toEqual({
        imapHost: "imap.gmail.com",
        imapPort: 993,
        smtpHost: "smtp.gmail.com",
        smtpPort: 587,
        security: "tls",
      });
    });

    it("returns { config: {}, source: 'none' } when the email query param is missing", async () => {
      const { GET } = await import("@/app/api/integrations/imap/autodiscover/route");
      const response = await GET(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ config: {}, source: "none" });
    });

    it("returns { config: {}, source: 'none' } for an empty email query param", async () => {
      const { GET } = await import("@/app/api/integrations/imap/autodiscover/route");
      const response = await GET(makeRequest("email="));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ config: {}, source: "none" });
    });

    it("returns { config: {}, source: 'none' } for an unparseable email", async () => {
      const { GET } = await import("@/app/api/integrations/imap/autodiscover/route");
      const response = await GET(makeRequest("email=not-an-email"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ config: {}, source: "none" });
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

const { mockAuthenticate, mockVersion } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockVersion: vi.fn(),
}));

vi.mock("odoo-node", () => {
  class OdooClient {
    version = mockVersion;
    static authenticate = mockAuthenticate;
  }
  return { OdooClient };
});

vi.mock("@/lib/integrations/pipedrive-api", () => ({
  getPipedriveBaseUrl: vi.fn().mockReturnValue("https://api.pipedrive.com"),
}));

import { getSession } from "@/lib/auth";
import { POST } from "@/app/api/integrations/test-credentials/route";

const adminSession = {
  user: { id: "admin-1", role: "admin" },
  expires: "",
} as const;

const memberSession = {
  user: { id: "user-1", role: "member" },
  expires: "",
} as const;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/integrations/test-credentials", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/integrations/test-credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await POST(makeRequest({ type: "pipedrive", credentials: { apiToken: "x" } }));
    expect(response.status).toBe(401);
  });

  it("returns 403 when not admin", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(memberSession as never);
    const response = await POST(makeRequest({ type: "pipedrive", credentials: { apiToken: "x" } }));
    expect(response.status).toBe(403);
  });

  it("returns 400 on validation failure", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    const response = await POST(makeRequest({ type: "pipedrive", credentials: {} }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
  });

  describe("Pipedrive", () => {
    it("returns success with company info on valid token", async () => {
      vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
      const fetchMock = vi.fn().mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            company_domain: "acme",
            company_name: "Acme Corp",
            id: 7,
            name: "Alice",
          },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await POST(
        makeRequest({ type: "pipedrive", credentials: { apiToken: "token-123" } })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        success: true,
        companyDomain: "acme",
        companyName: "Acme Corp",
        userId: 7,
        userName: "Alice",
      });

      // Sends x-api-token header, never in query string (no token leakage)
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.pipedrive.com/v1/users/me");
      expect(init.headers["x-api-token"]).toBe("token-123");
      expect(String(url)).not.toContain("token-123");
    });

    it("returns success:false when API rejects token", async () => {
      vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          json: async () => ({ success: false, error: "Invalid API key" }),
        })
      );

      const response = await POST(
        makeRequest({ type: "pipedrive", credentials: { apiToken: "bad" } })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ success: false, error: "Invalid API key" });
    });

    it("returns success:false when fetch throws", async () => {
      vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
      vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network down")));

      const response = await POST(
        makeRequest({ type: "pipedrive", credentials: { apiToken: "t" } })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ success: false, error: "network down" });
    });
  });

  describe("Odoo", () => {
    it("rejects private/localhost URLs", async () => {
      vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
      const response = await POST(
        makeRequest({
          type: "odoo",
          credentials: {
            url: "http://localhost:8069",
            db: "prod",
            login: "admin",
            apiKey: "key",
          },
        })
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/private|localhost|external/i);
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it("returns version + uid on successful authentication", async () => {
      vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
      mockAuthenticate.mockResolvedValueOnce(42);
      mockVersion.mockResolvedValueOnce({ serverVersion: "17.0" });

      const response = await POST(
        makeRequest({
          type: "odoo",
          credentials: {
            url: "https://odoo.example.com",
            db: "prod",
            login: "admin",
            apiKey: "key",
          },
        })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ success: true, version: "17.0", uid: 42 });
    });

    it("returns success:false when authenticate throws", async () => {
      vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
      mockAuthenticate.mockRejectedValueOnce(new Error("bad credentials"));

      const response = await POST(
        makeRequest({
          type: "odoo",
          credentials: {
            url: "https://odoo.example.com",
            db: "prod",
            login: "admin",
            apiKey: "key",
          },
        })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ success: false, error: "bad credentials" });
    });
  });
});

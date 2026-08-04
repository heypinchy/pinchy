import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockValidateExternalUrl = vi.fn();
vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: (...args: unknown[]) => mockValidateExternalUrl(...args),
}));

const mockFetchOdooSchema = vi.fn();
vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: (...args: unknown[]) => mockFetchOdooSchema(...args),
}));

import { NextRequest } from "next/server";
import { routeContext } from "@/test-helpers/route";

function makeRequest(path: string, options?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost:7777${path}`, options);
}

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };
const memberSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

const validCredentials = {
  url: "https://odoo.example.com",
  db: "prod",
  login: "admin",
  apiKey: "secret-key",
  uid: 2,
};

const validSyncResult = {
  success: true,
  models: 2,
  lastSyncAt: "2026-01-01T00:00:00.000Z",
  categories: [{ category: "sales", count: 1 }],
  data: {
    models: [
      {
        model: "sale.order",
        name: "Sales Order",
        fields: [],
        access: { read: true, create: false, write: false, delete: false },
      },
    ],
    lastSyncAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("POST /api/integrations/sync-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockValidateExternalUrl.mockReturnValue({ valid: true, url: "https://odoo.example.com" });
    mockFetchOdooSchema.mockResolvedValue(validSyncResult);
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const request = makeRequest("/api/integrations/sync-preview", {
      method: "POST",
      body: JSON.stringify({ type: "odoo", credentials: validCredentials }),
    });
    const response = await POST(request, routeContext());

    expect(response.status).toBe(401);
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const request = makeRequest("/api/integrations/sync-preview", {
      method: "POST",
      body: JSON.stringify({ type: "odoo", credentials: validCredentials }),
    });
    const response = await POST(request, routeContext());

    expect(response.status).toBe(403);
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("should return 400 when required credential fields are missing", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const request = makeRequest("/api/integrations/sync-preview", {
      method: "POST",
      body: JSON.stringify({
        type: "odoo",
        credentials: { url: "https://odoo.example.com" },
      }),
    });
    const response = await POST(request, routeContext());

    expect(response.status).toBe(400);
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("should return 400 for an invalid url", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const request = makeRequest("/api/integrations/sync-preview", {
      method: "POST",
      body: JSON.stringify({
        type: "odoo",
        credentials: { ...validCredentials, url: "not-a-url" },
      }),
    });
    const response = await POST(request, routeContext());

    expect(response.status).toBe(400);
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("should return 400 for a non-odoo type", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const request = makeRequest("/api/integrations/sync-preview", {
      method: "POST",
      body: JSON.stringify({ type: "web-search", credentials: { apiKey: "x" } }),
    });
    const response = await POST(request, routeContext());

    expect(response.status).toBe(400);
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("rejects the request when validateExternalUrl refuses the target and never calls fetchOdooSchema", async () => {
    // Pins the SSRF ordering: validation must run BEFORE the outbound fetch,
    // and a rejection must short-circuit the route entirely.
    mockValidateExternalUrl.mockReturnValue({
      valid: false,
      error: "URLs targeting private or internal networks are not allowed",
    });
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const request = makeRequest("/api/integrations/sync-preview", {
      method: "POST",
      body: JSON.stringify({
        type: "odoo",
        credentials: { ...validCredentials, url: "http://169.254.169.254/" },
      }),
    });
    const response = await POST(request, routeContext());
    const body = await response.json();

    expect(mockValidateExternalUrl).toHaveBeenCalledWith("http://169.254.169.254/");
    expect(response.status).toBe(400);
    expect(body.error).toBe("URLs targeting private or internal networks are not allowed");
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("returns the schema from fetchOdooSchema when the url passes SSRF validation", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const request = makeRequest("/api/integrations/sync-preview", {
      method: "POST",
      body: JSON.stringify({ type: "odoo", credentials: validCredentials }),
    });
    const response = await POST(request, routeContext());
    const body = await response.json();

    expect(mockValidateExternalUrl).toHaveBeenCalledWith(validCredentials.url);
    expect(mockFetchOdooSchema).toHaveBeenCalledWith(validCredentials);
    expect(response.status).toBe(200);
    expect(body).toEqual(validSyncResult);
  });
});

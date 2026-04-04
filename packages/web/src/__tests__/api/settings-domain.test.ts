import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

const mockSetDomainAndRefreshCache = vi.fn().mockResolvedValue(undefined);
const mockDeleteDomainAndRefreshCache = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/domain", () => ({
  setDomainAndRefreshCache: (...args: unknown[]) => mockSetDomainAndRefreshCache(...args),
  deleteDomainAndRefreshCache: (...args: unknown[]) => mockDeleteDomainAndRefreshCache(...args),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

import { POST, DELETE, GET } from "@/app/api/settings/domain/route";

const adminSession = {
  user: { id: "admin-1", email: "admin@test.com", role: "admin" },
};

function makeRequest(method: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/settings/domain", {
    method,
    headers,
  });
}

describe("POST /api/settings/domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminSession);
  });

  it("should reject when not admin", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mockRequireAdmin.mockResolvedValueOnce(forbidden);

    const response = await POST(makeRequest("POST"));
    expect(response.status).toBe(403);
  });

  it("should reject when request is not over HTTPS", async () => {
    const response = await POST(
      makeRequest("POST", {
        "x-forwarded-host": "pinchy.example.com",
        "x-forwarded-proto": "http",
      })
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/HTTPS/i);
  });

  it("should reject when x-forwarded-proto is missing (not HTTPS)", async () => {
    const response = await POST(
      makeRequest("POST", {
        host: "pinchy.example.com",
      })
    );
    expect(response.status).toBe(400);
  });

  it("should reject when hostname cannot be determined", async () => {
    const response = await POST(
      makeRequest("POST", {
        "x-forwarded-proto": "https",
      })
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/hostname/i);
    expect(mockSetDomainAndRefreshCache).not.toHaveBeenCalled();
  });

  it("should save domain and return success with restart flag when valid HTTPS request", async () => {
    mockGetSetting.mockResolvedValueOnce(null);

    const response = await POST(
      makeRequest("POST", {
        "x-forwarded-host": "pinchy.example.com",
        "x-forwarded-proto": "https",
      })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.domain).toBe("pinchy.example.com");
    expect(data.restart).toBe(true);
    expect(mockSetDomainAndRefreshCache).toHaveBeenCalledWith("pinchy.example.com");
  });

  it("should use x-forwarded-host over host header", async () => {
    mockGetSetting.mockResolvedValueOnce(null);

    const response = await POST(
      makeRequest("POST", {
        "x-forwarded-host": "forwarded.example.com",
        host: "direct.example.com",
        "x-forwarded-proto": "https",
      })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.domain).toBe("forwarded.example.com");
  });

  it("should fall back to host header when x-forwarded-host is missing", async () => {
    mockGetSetting.mockResolvedValueOnce(null);

    const response = await POST(
      makeRequest("POST", {
        host: "direct.example.com",
        "x-forwarded-proto": "https",
      })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.domain).toBe("direct.example.com");
  });

  it("should log an audit event with correct payload", async () => {
    mockGetSetting.mockResolvedValueOnce("old.example.com");

    await POST(
      makeRequest("POST", {
        "x-forwarded-host": "new.example.com",
        "x-forwarded-proto": "https",
      })
    );

    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "settings.updated",
      resource: "settings:domain",
      detail: {
        changes: { domain: { from: "old.example.com", to: "new.example.com" } },
      },
    });
  });
});

describe("DELETE /api/settings/domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminSession);
  });

  it("should reject when not admin", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mockRequireAdmin.mockResolvedValueOnce(forbidden);

    const response = await DELETE(makeRequest("DELETE"));
    expect(response.status).toBe(403);
  });

  it("should return 400 when no domain is locked", async () => {
    mockGetSetting.mockResolvedValueOnce(null);

    const response = await DELETE(makeRequest("DELETE"));
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/no domain/i);
  });

  it("should delete domain and return success with restart flag", async () => {
    mockGetSetting.mockResolvedValueOnce("pinchy.example.com");

    const response = await DELETE(makeRequest("DELETE"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.removed).toBe(true);
    expect(data.restart).toBe(true);
    expect(mockDeleteDomainAndRefreshCache).toHaveBeenCalled();
  });

  it("should log an audit event on removal", async () => {
    mockGetSetting.mockResolvedValueOnce("pinchy.example.com");

    await DELETE(makeRequest("DELETE"));

    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "settings.updated",
      resource: "settings:domain",
      detail: {
        changes: { domain: { from: "pinchy.example.com", to: null } },
      },
    });
  });
});

describe("GET /api/settings/domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminSession);
  });

  it("should reject when not admin", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mockRequireAdmin.mockResolvedValueOnce(forbidden);

    const response = await GET(makeRequest("GET"));
    expect(response.status).toBe(403);
  });

  it("should return current domain and HTTPS status when domain is set", async () => {
    mockGetSetting.mockResolvedValueOnce("pinchy.example.com");

    const response = await GET(
      makeRequest("GET", {
        "x-forwarded-host": "pinchy.example.com",
        "x-forwarded-proto": "https",
      })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.domain).toBe("pinchy.example.com");
    expect(data.currentHost).toBe("pinchy.example.com");
    expect(data.isHttps).toBe(true);
  });

  it("should return null domain and HTTP status when not configured", async () => {
    mockGetSetting.mockResolvedValueOnce(null);

    const response = await GET(
      makeRequest("GET", {
        host: "localhost:7777",
      })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.domain).toBeNull();
    expect(data.currentHost).toBe("localhost:7777");
    expect(data.isHttps).toBe(false);
  });
});

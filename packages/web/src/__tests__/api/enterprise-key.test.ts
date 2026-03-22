// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn();
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

vi.mock("@/lib/settings", () => ({
  setSetting: vi.fn().mockResolvedValue(undefined),
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/enterprise", () => ({
  clearLicenseCache: vi.fn(),
  getLicenseStatus: vi.fn(),
  isKeyFromEnv: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { getSession } from "@/lib/auth";
import { setSetting, deleteSetting } from "@/lib/settings";
import { clearLicenseCache, getLicenseStatus } from "@/lib/enterprise";
import { appendAuditLog } from "@/lib/audit";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/enterprise/key", () => {
  it("returns 401 for unauthenticated requests", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const { PUT } = await import("@/app/api/enterprise/key/route");
    const req = new Request("http://localhost/api/enterprise/key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "test" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      user: { id: "u1", role: "member", name: "User" },
    } as any);
    const { PUT } = await import("@/app/api/enterprise/key/route");
    const req = new Request("http://localhost/api/enterprise/key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "test" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 for missing key", async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      user: { id: "u1", role: "admin", name: "Admin" },
    } as any);
    const { PUT } = await import("@/app/api/enterprise/key/route");
    const req = new Request("http://localhost/api/enterprise/key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("saves valid key, clears cache, logs audit, returns status", async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      user: { id: "u1", role: "admin", name: "Admin" },
    } as any);
    vi.mocked(getLicenseStatus).mockResolvedValueOnce({
      active: true,
      type: "paid",
      org: "test-org",
      features: ["enterprise"],
      expiresAt: new Date("2027-01-01"),
      daysRemaining: 300,
    });

    const { PUT } = await import("@/app/api/enterprise/key/route");
    const req = new Request("http://localhost/api/enterprise/key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "eyJ.valid.token" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);

    // Verify save flow
    expect(setSetting).toHaveBeenCalledWith("enterprise_key", "eyJ.valid.token", true);
    expect(clearLicenseCache).toHaveBeenCalled();
    expect(getLicenseStatus).toHaveBeenCalled();
    expect(appendAuditLog).toHaveBeenCalled();

    // Verify response contains status
    const body = await res.json();
    expect(body.enterprise).toBe(true);
    expect(body.type).toBe("paid");
  });

  it("deletes key and returns 400 when key is invalid", async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      user: { id: "u1", role: "admin", name: "Admin" },
    } as any);
    vi.mocked(getLicenseStatus).mockResolvedValueOnce({
      active: false,
      features: [],
    } as any);

    const { PUT } = await import("@/app/api/enterprise/key/route");
    const req = new Request("http://localhost/api/enterprise/key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "invalid-token" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);

    // Should have tried to save, then deleted when invalid
    expect(setSetting).toHaveBeenCalled();
    expect(clearLicenseCache).toHaveBeenCalled();
    expect(deleteSetting).toHaveBeenCalledWith("enterprise_key");
    // Should NOT log audit for failed attempt
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

const mockClearLicenseCache = vi.fn();
vi.mock("@/lib/enterprise", () => ({
  clearLicenseCache: mockClearLicenseCache,
  isEnterprise: vi.fn().mockResolvedValue(false),
}));

import { requireAdmin } from "@/lib/api-auth";

describe("POST /api/dev/enterprise-toggle", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalKey = process.env.PINCHY_ENTERPRISE_KEY;

  let POST: typeof import("@/app/api/dev/enterprise-toggle/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "development";
    delete process.env.PINCHY_ENTERPRISE_KEY;

    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof requireAdmin> extends Promise<infer T> ? T : never);

    const mod = await import("@/app/api/dev/enterprise-toggle/route");
    POST = mod.POST;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalKey !== undefined) {
      process.env.PINCHY_ENTERPRISE_KEY = originalKey;
    } else {
      delete process.env.PINCHY_ENTERPRISE_KEY;
    }
  });

  it("returns 404 in production", async () => {
    process.env.NODE_ENV = "production";
    const response = await POST();
    expect(response.status).toBe(404);
  });

  it("returns 401 for unauthenticated users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const response = await POST();
    expect(response.status).toBe(401);
  });

  it("enables enterprise when currently disabled", async () => {
    delete process.env.PINCHY_ENTERPRISE_KEY;
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.enterprise).toBe(true);
    expect(process.env.PINCHY_ENTERPRISE_KEY).toBeTruthy();
    expect(mockClearLicenseCache).toHaveBeenCalled();
  });

  it("disables enterprise when currently enabled", async () => {
    process.env.PINCHY_ENTERPRISE_KEY = "some-key";
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.enterprise).toBe(false);
    expect(process.env.PINCHY_ENTERPRISE_KEY).toBeUndefined();
    expect(mockClearLicenseCache).toHaveBeenCalled();
  });
});

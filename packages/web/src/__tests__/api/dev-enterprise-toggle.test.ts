import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

const mockClearLicenseCache = vi.fn();
const mockIsEnterprise = vi.fn();
vi.mock("@/lib/enterprise", () => ({
  clearLicenseCache: mockClearLicenseCache,
  isEnterprise: mockIsEnterprise,
}));

const mockSetSetting = vi.fn().mockResolvedValue(undefined);
const mockDeleteSetting = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/settings", () => ({
  setSetting: mockSetSetting,
  deleteSetting: mockDeleteSetting,
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
    mockIsEnterprise.mockResolvedValueOnce(false);
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.enterprise).toBe(true);
    expect(mockSetSetting).toHaveBeenCalledWith("enterprise_key", expect.any(String), true);
    expect(mockClearLicenseCache).toHaveBeenCalledTimes(2);
  });

  it("disables enterprise when currently enabled", async () => {
    mockIsEnterprise.mockResolvedValueOnce(true);
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.enterprise).toBe(false);
    expect(mockDeleteSetting).toHaveBeenCalledWith("enterprise_key");
    expect(mockClearLicenseCache).toHaveBeenCalledTimes(2);
  });

  it("clears PINCHY_ENTERPRISE_KEY env var", async () => {
    process.env.PINCHY_ENTERPRISE_KEY = "some-key";
    mockIsEnterprise.mockResolvedValueOnce(true);
    await POST();
    expect(process.env.PINCHY_ENTERPRISE_KEY).toBeUndefined();
  });
});

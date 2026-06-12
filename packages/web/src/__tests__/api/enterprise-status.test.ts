import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/enterprise", () => ({
  getLicenseStatus: vi.fn(),
  isKeyFromEnv: vi.fn(),
}));
vi.mock("@/lib/seat-usage", () => ({
  getSeatUsage: vi.fn(),
}));
vi.mock("@/lib/gated-config", () => ({
  hasGatedConfig: vi.fn(),
}));

const { getSession } = await import("@/lib/auth");
const { getLicenseStatus, isKeyFromEnv } = await import("@/lib/enterprise");
const { getSeatUsage } = await import("@/lib/seat-usage");
const { hasGatedConfig } = await import("@/lib/gated-config");

describe("GET /api/enterprise/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1" },
    });
    (isKeyFromEnv as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it("includes seatsUsed and maxUsers in the response", async () => {
    (getLicenseStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      ver: 1,
      maxUsers: 10,
      features: ["enterprise"],
      type: "paid",
      org: "TestCo",
    });
    (getSeatUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      used: 7,
      max: 10,
      available: 3,
      unlimited: false,
      activeUsers: 5,
      pendingInvites: 2,
    });
    const { GET } = await import("@/app/api/enterprise/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body.seatsUsed).toBe(7);
    expect(body.maxUsers).toBe(10);
  });

  it("computes seatsUsed even when license is unlimited", async () => {
    (getLicenseStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      ver: 1,
      maxUsers: 0,
      features: ["enterprise"],
    });
    (getSeatUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      used: 12,
      max: 0,
      available: null,
      unlimited: true,
      activeUsers: 12,
      pendingInvites: 0,
    });
    const { GET } = await import("@/app/api/enterprise/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body.seatsUsed).toBe(12);
    expect(body.maxUsers).toBe(0);
  });

  it("skips getSeatUsage and returns seatsUsed=0 when license is inactive", async () => {
    (getLicenseStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: false,
      ver: 1,
      maxUsers: 0,
      features: [],
    });
    const { GET } = await import("@/app/api/enterprise/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body.enterprise).toBe(false);
    expect(body.seatsUsed).toBe(0);
    expect(body.maxUsers).toBe(0);
    expect(getSeatUsage).not.toHaveBeenCalled();
  });

  it("reports state=community without a key and does not query gated config eagerly for active licenses", async () => {
    (getLicenseStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: false,
      ver: 1,
      maxUsers: 0,
      features: [],
    });
    (hasGatedConfig as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { GET } = await import("@/app/api/enterprise/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body.state).toBe("community");
    expect(body.paidUntil).toBeNull();
    expect(body.hasGatedConfig).toBe(false);
  });

  it("reports state=paid with paidUntil for a valid paid key", async () => {
    const paidUntilAt = new Date(Date.now() + 100 * 86400000);
    (getLicenseStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      ver: 1,
      maxUsers: 10,
      features: ["enterprise"],
      type: "paid",
      org: "TestCo",
      paidUntilAt,
      expiresAt: new Date(paidUntilAt.getTime() + 30 * 86400000),
    });
    (getSeatUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      used: 7,
      max: 10,
      available: 3,
      unlimited: false,
      activeUsers: 5,
      pendingInvites: 2,
    });
    const { GET } = await import("@/app/api/enterprise/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body.state).toBe("paid");
    expect(body.paidUntil).toBe(paidUntilAt.toISOString());
    expect(hasGatedConfig).not.toHaveBeenCalled();
  });

  it("reports state=grace when paidUntil has passed but exp has not", async () => {
    (getLicenseStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      ver: 1,
      maxUsers: 10,
      features: ["enterprise"],
      type: "paid",
      paidUntilAt: new Date(Date.now() - 86400000),
      expiresAt: new Date(Date.now() + 29 * 86400000),
    });
    (getSeatUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      used: 7,
      max: 10,
      available: 3,
      unlimited: false,
      activeUsers: 7,
      pendingInvites: 0,
    });
    const { GET } = await import("@/app/api/enterprise/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body.state).toBe("grace");
  });

  it("reports state=expired with claims and gated-config flag for an expired paid key", async () => {
    const paidUntilAt = new Date(Date.now() - 40 * 86400000);
    const expiresAt = new Date(Date.now() - 10 * 86400000);
    (getLicenseStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: false,
      expired: true,
      ver: 1,
      maxUsers: 10,
      features: ["enterprise"],
      type: "paid",
      org: "TestCo",
      paidUntilAt,
      expiresAt,
    });
    (hasGatedConfig as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const { GET } = await import("@/app/api/enterprise/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body.enterprise).toBe(false);
    expect(body.state).toBe("expired");
    expect(body.paidUntil).toBe(paidUntilAt.toISOString());
    expect(body.expiresAt).toBe(expiresAt.toISOString());
    expect(body.hasGatedConfig).toBe(true);
  });

  it("reports state=trial-expired for an expired trial key", async () => {
    (getLicenseStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: false,
      expired: true,
      ver: 1,
      maxUsers: 50,
      features: ["enterprise"],
      type: "trial",
      expiresAt: new Date(Date.now() - 86400000),
    });
    (hasGatedConfig as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { GET } = await import("@/app/api/enterprise/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body.state).toBe("trial-expired");
  });
});

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

const { getSession } = await import("@/lib/auth");
const { getLicenseStatus, isKeyFromEnv } = await import("@/lib/enterprise");
const { getSeatUsage } = await import("@/lib/seat-usage");

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
});

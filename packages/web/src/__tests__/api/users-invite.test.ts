import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/invites", () => ({
  createInvite: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/enterprise", () => ({
  getLicenseStatus: vi.fn(),
}));

vi.mock("@/lib/seat-usage", () => ({
  getSeatUsage: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    inArray: vi.fn(),
  };
});

import { requireAdmin } from "@/lib/api-auth";
import { createInvite } from "@/lib/invites";
import { appendAuditLog } from "@/lib/audit";
import { getLicenseStatus } from "@/lib/enterprise";
import { getSeatUsage } from "@/lib/seat-usage";

function makeRequest(body: object) {
  return new NextRequest("http://localhost/api/users/invite", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/users/invite — seat cap", () => {
  let POST: typeof import("@/app/api/users/invite/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof requireAdmin> extends Promise<infer T> ? T : never);
    vi.mocked(createInvite).mockResolvedValue({
      id: "inv-1",
      tokenHash: "h",
    } as never);
    const mod = await import("@/app/api/users/invite/route");
    POST = mod.POST;
  });

  it("returns 403 when seat cap is reached", async () => {
    vi.mocked(getLicenseStatus).mockResolvedValue({
      active: true,
      ver: 1,
      maxUsers: 10,
      features: ["enterprise"],
    });
    vi.mocked(getSeatUsage).mockResolvedValue({
      used: 10,
      max: 10,
      available: 0,
      unlimited: false,
      activeUsers: 8,
      pendingInvites: 2,
    });
    const res = await POST(makeRequest({ email: "new@test.com", role: "member" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Seat limit reached");
    expect(body.seatsUsed).toBe(10);
    expect(body.maxUsers).toBe(10);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("logs an audit event with outcome=failure when blocked", async () => {
    vi.mocked(getLicenseStatus).mockResolvedValue({
      active: true,
      ver: 1,
      maxUsers: 5,
      features: ["enterprise"],
    });
    vi.mocked(getSeatUsage).mockResolvedValue({
      used: 5,
      max: 5,
      available: 0,
      unlimited: false,
      activeUsers: 5,
      pendingInvites: 0,
    });
    await POST(makeRequest({ email: "new@test.com", role: "member" }));
    // after() runs synchronously in tests (see test-setup.ts)
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "user.invite_blocked",
        outcome: "failure",
        error: { message: "Seat cap reached" },
        detail: expect.objectContaining({
          email: "new@test.com",
          role: "member",
          reason: "seat_cap",
          seatsUsed: 5,
          maxUsers: 5,
        }),
      })
    );
  });

  it("creates the invite when below the cap", async () => {
    vi.mocked(getLicenseStatus).mockResolvedValue({
      active: true,
      ver: 1,
      maxUsers: 10,
      features: ["enterprise"],
    });
    vi.mocked(getSeatUsage).mockResolvedValue({
      used: 3,
      max: 10,
      available: 7,
      unlimited: false,
      activeUsers: 3,
      pendingInvites: 0,
    });
    const res = await POST(makeRequest({ email: "new@test.com", role: "member" }));
    expect(res.status).toBe(201);
    expect(createInvite).toHaveBeenCalled();
  });

  it("does not check seat usage when license is unlimited", async () => {
    vi.mocked(getLicenseStatus).mockResolvedValue({
      active: true,
      ver: 1,
      maxUsers: 0,
      features: ["enterprise"],
    });
    const res = await POST(makeRequest({ email: "new@test.com", role: "member" }));
    expect(res.status).toBe(201);
    expect(getSeatUsage).not.toHaveBeenCalled();
  });

  it("does not check seat usage when no enterprise license", async () => {
    vi.mocked(getLicenseStatus).mockResolvedValue({
      active: false,
      ver: 1,
      maxUsers: 0,
      features: [],
    });
    const res = await POST(makeRequest({ email: "new@test.com", role: "member" }));
    expect(res.status).toBe(201);
    expect(getSeatUsage).not.toHaveBeenCalled();
  });
});

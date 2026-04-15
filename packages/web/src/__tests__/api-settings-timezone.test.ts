import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getAllSettings: vi.fn().mockResolvedValue([]),
  setSetting: vi.fn().mockResolvedValue(undefined),
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/settings-timezone");
vi.mock("@/lib/audit");

import { auth } from "@/lib/auth";
import * as tz from "@/lib/settings-timezone";
import * as audit from "@/lib/audit";

describe("POST /api/settings — timezone", () => {
  let POST: typeof import("@/app/api/settings/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/settings/route");
    POST = mod.POST;

    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
  });

  it("updates org.timezone and logs audit event with from/to diff", async () => {
    vi.mocked(tz.getOrgTimezone).mockResolvedValue("UTC");
    vi.mocked(tz.setOrgTimezone).mockResolvedValue(undefined);

    const req = new Request("http://test/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "org.timezone", value: "Europe/Vienna" }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(200);
    expect(tz.setOrgTimezone).toHaveBeenCalledWith("Europe/Vienna");
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "settings.updated",
        detail: { timezone: { from: "UTC", to: "Europe/Vienna" } },
        outcome: "success",
      })
    );
  });

  it("rejects invalid timezone with 400", async () => {
    vi.mocked(tz.getOrgTimezone).mockResolvedValue("UTC");
    vi.mocked(tz.setOrgTimezone).mockRejectedValue(new Error("invalid IANA timezone: X"));

    const req = new Request("http://test/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "org.timezone", value: "X" }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(400);
  });
});

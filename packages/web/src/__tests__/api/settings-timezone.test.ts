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

// Keep the real, pure `isValidIanaTimezone` so the invalid → 400 case is driven
// by the actual validator path; only the I/O helpers are stubbed.
vi.mock("@/lib/settings-timezone", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/settings-timezone")>();
  return {
    ...actual,
    getOrgTimezone: vi.fn(),
    setOrgTimezone: vi.fn(),
  };
});
vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import * as tz from "@/lib/settings-timezone";
import * as audit from "@/lib/audit";
import { after } from "next/server";

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
    expect(await res.json()).toEqual({ success: true });
    expect(tz.setOrgTimezone).toHaveBeenCalledWith("Europe/Vienna");
    expect(after).toHaveBeenCalledTimes(1);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "settings.updated",
        detail: { changes: { timezone: { from: "UTC", to: "Europe/Vienna" } } },
        outcome: "success",
      })
    );
  });

  it("rejects invalid timezone with 400 before touching persistence", async () => {
    vi.mocked(tz.getOrgTimezone).mockResolvedValue("UTC");

    const req = new Request("http://test/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "org.timezone", value: "Not/AZone" }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: expect.stringMatching(/invalid/i) });
    // Validation happens before persistence, so setSetting is never reached.
    expect(tz.setOrgTimezone).not.toHaveBeenCalled();
  });

  it("propagates a persistence failure instead of masking it as a 400", async () => {
    vi.mocked(tz.getOrgTimezone).mockResolvedValue("UTC");
    // Valid zone, but the DB write fails: this must surface as a genuine error
    // (→ 500 via the framework), never be reported to the client as a 400.
    vi.mocked(tz.setOrgTimezone).mockRejectedValue(new Error("db down"));

    const req = new Request("http://test/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "org.timezone", value: "Europe/Vienna" }),
    });
    await expect(POST(req as any)).rejects.toThrow(/db down/);
  });

  it("does not write an audit event when the timezone is unchanged (from === to)", async () => {
    vi.mocked(tz.getOrgTimezone).mockResolvedValue("Europe/Vienna");
    vi.mocked(tz.setOrgTimezone).mockResolvedValue(undefined);

    const req = new Request("http://test/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "org.timezone", value: "Europe/Vienna" }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    // A no-op save (same value) must not spam the audit log with from===to rows.
    expect(after).not.toHaveBeenCalled();
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });
});

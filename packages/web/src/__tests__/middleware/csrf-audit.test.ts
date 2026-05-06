import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { logCsrfBlocked } from "@/server/csrf-check";
import { appendAuditLog } from "@/lib/audit";

describe("logCsrfBlocked", () => {
  beforeEach(() => {
    vi.mocked(appendAuditLog).mockClear();
  });

  it("appends an auth.csrf_blocked audit entry with the request context", async () => {
    await logCsrfBlocked({
      reason: "origin-mismatch",
      method: "POST",
      pathname: "/api/users/invite",
      origin: "https://evil.example.com",
      referer: undefined,
      remoteAddress: "203.0.113.42",
    });

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.eventType).toBe("auth.csrf_blocked");
    expect(call.outcome).toBe("failure");
    expect(call.actorType).toBe("system");
    expect(call.actorId).toBe("system");
    expect(call.error?.message).toMatch(/origin-mismatch/);
    expect(call.detail).toMatchObject({
      method: "POST",
      pathname: "/api/users/invite",
      origin: "https://evil.example.com",
      referer: null,
      remoteAddress: "203.0.113.42",
    });
  });

  it("uses null for missing origin/referer/remoteAddress", async () => {
    await logCsrfBlocked({
      reason: "missing-origin-and-referer",
      method: "DELETE",
      pathname: "/api/agents/abc",
      origin: undefined,
      referer: undefined,
      remoteAddress: undefined,
    });

    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.detail).toMatchObject({
      origin: null,
      referer: null,
      remoteAddress: null,
    });
  });

  it("does not throw when appendAuditLog rejects (best-effort logging)", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("DB down"));

    await expect(
      logCsrfBlocked({
        reason: "origin-mismatch",
        method: "POST",
        pathname: "/api/agents",
        origin: "https://evil.example.com",
        referer: undefined,
        remoteAddress: "1.2.3.4",
      })
    ).resolves.toBeUndefined();
  });
});

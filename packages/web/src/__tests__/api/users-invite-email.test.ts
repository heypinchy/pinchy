import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { mockSession } from "@/test-helpers/auth";

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("@/lib/api-auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/invites", () => ({ createInvite: vi.fn() }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, appendAuditLog: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/enterprise", () => ({
  getLicenseStatus: vi.fn().mockResolvedValue({ active: false, ver: 1, maxUsers: 0, features: [] }),
}));
vi.mock("@/lib/seat-usage", () => ({ getSeatUsage: vi.fn() }));
vi.mock("@/lib/system-mail/deliver", () => ({ deliverLinkEmail: vi.fn() }));
vi.mock("@/db", () => ({ db: {} }));

import { requireAdmin } from "@/lib/api-auth";
import { createInvite } from "@/lib/invites";
import { deliverLinkEmail } from "@/lib/system-mail/deliver";
import { POST } from "@/app/api/users/invite/route";

const expiresAt = new Date("2026-11-12T10:00:00Z");

function makeRequest(body: object) {
  return new NextRequest("http://localhost/api/users/invite", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/users/invite — sendEmail (#1309)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUDIT_HMAC_SECRET", "f".repeat(64));
    vi.mocked(requireAdmin).mockResolvedValue(
      mockSession({ user: { id: "admin-1", role: "admin", name: "Clemens", email: "c@x.io" } })
    );
    vi.mocked(createInvite).mockResolvedValue({
      id: "inv-1",
      token: "tok123",
      expiresAt,
    } as never);
  });

  it("does not touch the mailer when no email was asked for", async () => {
    const res = await POST(makeRequest({ email: "anna@example.com", role: "member" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).not.toHaveProperty("emailDelivery");
    expect(deliverLinkEmail).not.toHaveBeenCalled();
  });

  it("emails the invitation after creating it", async () => {
    vi.mocked(deliverLinkEmail).mockResolvedValue({ sent: true });
    const res = await POST(
      makeRequest({ email: "anna@example.com", role: "member", sendEmail: true })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.emailDelivery).toEqual({ sent: true });
    expect(json.token).toBe("tok123");
    expect(deliverLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "invite",
        to: "anna@example.com",
        token: "tok123",
        inviteId: "inv-1",
        actor: { id: "admin-1", name: "Clemens", email: "c@x.io" },
      })
    );
  });

  it("never loses the invite when the send fails: 201, token and the error", async () => {
    vi.mocked(deliverLinkEmail).mockResolvedValue({
      sent: false,
      error: "Connection refused — check the host and port",
    });
    const res = await POST(
      makeRequest({ email: "anna@example.com", role: "member", sendEmail: true })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.token).toBe("tok123");
    expect(json.emailDelivery).toEqual({
      sent: false,
      error: "Connection refused — check the host and port",
    });
  });

  it("still answers 201 with the link if the mailer itself throws", async () => {
    vi.mocked(deliverLinkEmail).mockRejectedValue(new Error("boom"));
    const res = await POST(
      makeRequest({ email: "anna@example.com", role: "member", sendEmail: true })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.token).toBe("tok123");
    expect(json.emailDelivery.sent).toBe(false);
  });
});

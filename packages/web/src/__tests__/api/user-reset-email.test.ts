import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { mockSession } from "@/test-helpers/auth";

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("@/lib/api-auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/invites", () => ({ createInvite: vi.fn() }));
vi.mock("@/lib/system-mail/deliver", () => ({ deliverLinkEmail: vi.fn() }));
vi.mock("@/lib/audit-deferred", () => ({ deferAuditLog: vi.fn() }));
vi.mock("@/db", () => ({ db: { query: { users: { findFirst: vi.fn() } } } }));

import { requireAdmin } from "@/lib/api-auth";
import { createInvite } from "@/lib/invites";
import { deliverLinkEmail } from "@/lib/system-mail/deliver";
import { deferAuditLog } from "@/lib/audit-deferred";
import { db } from "@/db";
import { POST } from "@/app/api/users/[userId]/reset/route";

const params = { params: Promise.resolve({ userId: "user-2" }) };

function makeRequest(body?: string) {
  return new NextRequest("http://localhost/api/users/user-2/reset", {
    method: "POST",
    ...(body !== undefined ? { body } : {}),
  });
}

describe("POST /api/users/[userId]/reset — sendEmail (#1309)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue(
      mockSession({ user: { id: "admin-1", role: "admin", name: "Clemens", email: "c@x.io" } })
    );
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "user-2",
      name: "Anna",
      email: "anna@example.com",
      role: "member",
    } as never);
    vi.mocked(createInvite).mockResolvedValue({
      id: "inv-9",
      token: "reset-tok",
      expiresAt: new Date("2026-11-12T10:00:00Z"),
    } as never);
  });

  it("keeps working for a client that sends no body", async () => {
    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ token: "reset-tok" });
    expect(deliverLinkEmail).not.toHaveBeenCalled();
  });

  it("emails the reset link to the user when asked", async () => {
    vi.mocked(deliverLinkEmail).mockResolvedValue({ sent: true });
    const res = await POST(makeRequest(JSON.stringify({ sendEmail: true })), params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ token: "reset-tok", emailDelivery: { sent: true } });
    expect(deliverLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reset",
        to: "anna@example.com",
        token: "reset-tok",
        inviteId: "inv-9",
        actor: { id: "admin-1", name: "Clemens", email: "c@x.io" },
      })
    );
  });

  it("returns the link with the error when the send fails", async () => {
    vi.mocked(deliverLinkEmail).mockResolvedValue({ sent: false, error: "Connection refused" });
    const res = await POST(makeRequest(JSON.stringify({ sendEmail: true })), params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      token: "reset-tok",
      emailDelivery: { sent: false, error: "Connection refused" },
    });
  });

  it("rejects an unknown field", async () => {
    const res = await POST(makeRequest(JSON.stringify({ to: "someone@else.com" })), params);
    expect(res.status).toBe(400);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("audits a link-only reset with the target snapshot and no email address", async () => {
    await POST(makeRequest(), params);
    expect(deferAuditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(deferAuditLog).mock.calls[0][0];
    expect(entry).toMatchObject({
      actorType: "user",
      actorId: "admin-1",
      eventType: "user.password_reset_requested",
      resource: "user:user-2",
      outcome: "success",
      detail: { user: { id: "user-2", name: "Anna" }, via: "link", invite: { id: "inv-9" } },
    });
    expect(JSON.stringify(entry)).not.toContain("anna@example.com");
  });

  it("audits an emailed reset as sent by email, even when the send then fails", async () => {
    vi.mocked(deliverLinkEmail).mockResolvedValue({ sent: false, error: "Connection refused" });
    await POST(makeRequest(JSON.stringify({ sendEmail: true })), params);
    expect(vi.mocked(deferAuditLog).mock.calls[0][0]).toMatchObject({
      eventType: "user.password_reset_requested",
      outcome: "success",
      detail: { via: "email" },
    });
  });

  it("keeps the acting admin's raw id out of detail when an admin resets their own password", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "admin-1",
      name: "Clemens",
      email: "c@x.io",
      role: "admin",
    } as never);
    await POST(makeRequest(), { params: Promise.resolve({ userId: "admin-1" }) });
    const entry = vi.mocked(deferAuditLog).mock.calls[0][0];
    expect(entry.detail).toEqual({
      user: { name: "Clemens" },
      via: "link",
      invite: { id: "inv-9" },
    });
    expect(entry).toMatchObject({ resource: "user:admin-1" });
  });

  it("writes no audit row when the user does not exist", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    await POST(makeRequest(), params);
    expect(deferAuditLog).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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
vi.mock("@/lib/audit", () => ({ appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/db", () => ({
  db: {
    update: vi.fn(),
  },
}));

import { auth } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { users } from "@/db/schema";

describe("POST /api/users/[userId]/reactivate", () => {
  let POST: typeof import("@/app/api/users/[userId]/reactivate/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/[userId]/reactivate/route");
    POST = mod.POST;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost/api/users/u1/reactivate", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ userId: "u1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 when not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as never);
    const req = new NextRequest("http://localhost/api/users/u1/reactivate", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ userId: "u1" }) });
    expect(res.status).toBe(403);
  });

  it("unbans user by clearing banned flag", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as never);

    const mockUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "u1", email: "u@test.com", banned: false }]),
      }),
    };
    vi.mocked(db.update).mockReturnValueOnce(mockUpdate as never);

    const req = new NextRequest("http://localhost/api/users/u1/reactivate", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ userId: "u1" }) });

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledWith(users);
    expect(mockUpdate.set).toHaveBeenCalledWith({
      banned: false,
      banReason: null,
      banExpires: null,
    });
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "user.updated",
        detail: { changes: { status: { from: "deactivated", to: "active" } } },
      })
    );
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as never);

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const req = new NextRequest("http://localhost/api/users/nonexistent/reactivate", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ userId: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns 404 when user is already active (not banned)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as never);

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const req = new NextRequest("http://localhost/api/users/u1/reactivate", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ userId: "u1" }) });
    expect(res.status).toBe(404);
  });
});

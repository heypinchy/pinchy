import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

// Pins the § 5 carve-out: deactivating a user is a restriction-tightening
// operation and must work in EVERY license state. If the route ever grows a
// license gate, this inactive-license mock makes the pin test below fail.
vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(false),
  getLicenseState: vi.fn().mockResolvedValue("expired"),
  getLicenseStatus: vi.fn().mockResolvedValue({ active: false, features: [], ver: 1, maxUsers: 0 }),
}));

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

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/workspace", () => ({
  deleteWorkspace: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// The DELETE route recalculates Telegram allow-stores as a side effect; this
// suite asserts user-deletion + audit, not allow-store recalculation, so stub
// it out (it otherwise hits the DB via getSettingsByPrefix — #261).
vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db", () => {
  const db: Record<string, unknown> = {
    query: {
      users: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
  // Default: run the callback against the SAME db object, so tx.update /
  // tx.delete are the exact mocks above and existing per-test overrides via
  // db.update/db.delete.mockReturnValueOnce keep working unchanged.
  db.transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(db));
  return { db };
});

import { auth } from "@/lib/auth";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { users, sessions, agents } from "@/db/schema";

// ── GET /api/users ───────────────────────────────────────────────────────

describe("GET /api/users", () => {
  let GET: typeof import("@/app/api/users/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const response = await GET();
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns only selected user fields", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeUsers = [
      {
        id: "user-1",
        name: "Alice",
        email: "alice@test.com",
        role: "member",
        banned: false,
        userGroups: [],
      },
      {
        id: "admin-1",
        name: "Bob",
        email: "bob@test.com",
        role: "admin",
        banned: false,
        userGroups: [],
      },
    ];
    vi.mocked(db.query.users.findMany).mockResolvedValueOnce(fakeUsers as never);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.users).toHaveLength(2);
    expect(body.users[0].id).toBe("user-1");
    expect(body.users[0].name).toBe("Alice");
    expect(body.users[0].email).toBe("alice@test.com");
    expect(body.users[0].role).toBe("member");
    // Ensure only selected fields are returned (no sensitive data leaks)
    expect(Object.keys(body.users[0]).sort()).toEqual([
      "banned",
      "email",
      "groups",
      "id",
      "name",
      "role",
    ]);
  });

  it("includes banned status in user list", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeUsers = [
      {
        id: "user-1",
        name: "Alice",
        email: "alice@test.com",
        role: "member",
        banned: false,
        userGroups: [],
      },
      {
        id: "user-2",
        name: "Bob",
        email: "bob@test.com",
        role: "admin",
        banned: true,
        userGroups: [],
      },
    ];
    vi.mocked(db.query.users.findMany).mockResolvedValueOnce(fakeUsers as never);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.users[0].banned).toBe(false);
    expect(body.users[1].banned).toBe(true);
  });

  it("returns each user's groups via the relational query builder", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeUsers = [
      {
        id: "user-1",
        name: "Alice",
        email: "alice@test.com",
        role: "member",
        banned: false,
        userGroups: [
          { group: { id: "g1", name: "Engineering" } },
          { group: { id: "g2", name: "Design" } },
        ],
      },
    ];
    vi.mocked(db.query.users.findMany).mockResolvedValueOnce(fakeUsers as never);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.users[0].groups).toEqual([
      { id: "g1", name: "Engineering" },
      { id: "g2", name: "Design" },
    ]);
  });
});

// ── DELETE /api/users/[userId] ───────────────────────────────────────────

describe("DELETE /api/users/[userId]", () => {
  let DELETE: typeof import("@/app/api/users/[userId]/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/[userId]/route");
    DELETE = mod.DELETE;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/user-2", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "user-2" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 400 when admin tries to deactivate themselves", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/admin-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "admin-1" }),
    });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Cannot deactivate your own account");
  });

  it("bans user by setting banned flag", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as never);

    // Mock: select personal agents returns empty
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    // Mock: update returns the deactivated user
    const mockUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "user-1", name: "Test User", email: "u@test.com" }]),
      }),
    };
    vi.mocked(db.update).mockReturnValueOnce(mockUpdate as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", { method: "DELETE" });
    const response = await DELETE(request, { params: Promise.resolve({ userId: "user-1" }) });

    expect(response.status).toBe(200);
    expect(db.update).toHaveBeenCalledWith(users);
    expect(mockUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ banned: true, banReason: "Deactivated by admin" })
    );
    // A deactivated user's existing sessions must be revoked immediately —
    // otherwise the session cookie keeps full access until natural expiry.
    expect(db.delete).toHaveBeenCalledWith(sessions);
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "user.deleted",
        detail: { name: "Test User" },
      })
    );
  });

  it("deactivates users without an active license (restriction-tightening carve-out, § 5)", async () => {
    // The enterprise mock at the top of this file reports an EXPIRED license.
    // An admin must always be able to revoke access — a license that blocked
    // this would itself be the security risk.
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as never);

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const mockUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "user-1", name: "Test User", email: "u@test.com" }]),
      }),
    };
    vi.mocked(db.update).mockReturnValueOnce(mockUpdate as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", { method: "DELETE" });
    const response = await DELETE(request, { params: Promise.resolve({ userId: "user-1" }) });

    expect(response.status).toBe(200);
    expect(mockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ banned: true }));
  });

  it("does not record the user's email in the user.deleted audit detail (GDPR Art. 17)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as never);

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "user-1", name: "Test User", email: "secret@example.com" }]),
      }),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", { method: "DELETE" });
    await DELETE(request, { params: Promise.resolve({ userId: "user-1" }) });

    const call = vi
      .mocked(appendAuditLog)
      .mock.calls.find(([entry]) => entry.eventType === "user.deleted");
    expect(call).toBeDefined();
    const detail = call![0].detail as Record<string, unknown>;
    expect(detail).not.toHaveProperty("email");
    expect(JSON.stringify(detail)).not.toContain("secret@example.com");
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Mock: select personal agents returns empty
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    // Mock: update returns empty (user not found)
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/nonexistent", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "nonexistent" }),
    });
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("User not found");
  });

  it("returns 200 on successful deletion", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Mock: select personal agents returns one agent
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }]),
      }),
    } as never);

    // Mock: update returns the deactivated user
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1" }]),
      }),
    } as never);

    // Mock: update for personal agent soft-delete
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it("deletes user's personal agents' workspace files", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Mock: select personal agents returns two agents
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }, { id: "agent-2" }]),
      }),
    } as never);

    // Mock: update returns the deactivated user
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1" }]),
      }),
    } as never);

    // Mock: one batched update soft-deletes both personal agents (#…, N+1 fix)
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "DELETE",
    });

    await DELETE(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });

    expect(deleteWorkspace).toHaveBeenCalledWith("agent-1");
    expect(deleteWorkspace).toHaveBeenCalledWith("agent-2");
    expect(deleteWorkspace).toHaveBeenCalledTimes(2);
  });

  it("soft-deletes every personal agent in a single batched update, not one per agent", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }, { id: "agent-2" }]),
      }),
    } as never);

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1" }]),
      }),
    } as never);

    const agentUpdateSet = vi.fn().mockReturnThis();
    const agentUpdateWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValueOnce({
      set: agentUpdateSet,
      where: agentUpdateWhere,
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "DELETE",
    });

    await DELETE(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });

    // Ban + one batched agent update — never one db.update per agent.
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.update).toHaveBeenNthCalledWith(2, agents);
    expect(agentUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) })
    );
  });

  it("wraps ban + session revocation + agent soft-delete in a single transaction (atomic deactivation)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }]),
      }),
    } as never);

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1", name: "Test User" }]),
      }),
    } as never);

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });

    expect(response.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalledWith(sessions);
  });

  it("does not ban the user when the session revocation fails inside the transaction (atomicity)", async () => {
    // Simulates a real transaction's rollback semantics with a stateful fake
    // store: the ban only takes effect once the whole callback commits.
    // Pre-fix, the route calls db.update/db.delete directly (never touching
    // db.transaction), so this test's fake store is never exercised and the
    // DELETE resolves 200 instead of rejecting — the red state this test
    // starts from.
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    let bannedCommitted = false;
    vi.mocked(db.transaction).mockImplementationOnce((async (cb: (tx: unknown) => unknown) => {
      let pendingBanned = false;
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockImplementation(async () => {
                pendingBanned = true;
                return [{ id: "user-1", name: "Test User" }];
              }),
            }),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(async () => {
            throw new Error("session delete failed");
          }),
        }),
      };
      await cb(tx);
      // Only reached if cb() didn't throw — a real transaction rolls back on
      // any error inside the callback, so a thrown error must skip this line.
      bannedCommitted = pendingBanned;
    }) as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "DELETE",
    });

    await expect(
      DELETE(request, { params: Promise.resolve({ userId: "user-1" }) })
    ).rejects.toThrow("session delete failed");

    expect(bannedCommitted).toBe(false);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  // Regression for the event-loop-blocking finding: deleteWorkspace used to be
  // a synchronous rmSync call made directly in the request handler, so a large
  // (GB-sized knowledge-base) workspace froze the whole process — every other
  // chat and WS heartbeat — until it finished. It must now be scheduled via
  // after() (already used elsewhere in this file for the audit write) so it
  // runs once the response is on its way, not inline in the request path.
  it("schedules workspace deletion via after() rather than calling it synchronously in the request path", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }]),
      }),
    } as never);

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1" }]),
      }),
    } as never);

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    } as never);

    // test-setup.ts mocks next/server's after() to run its callback
    // immediately, so existing tests can assert deferred side effects without
    // a real request lifecycle. That default would make this test unable to
    // tell "called via after()" apart from "called synchronously in the
    // handler body" — so for THIS test only, capture the callbacks instead of
    // auto-running them, and restore the shared default afterwards.
    const { after } = await import("next/server");
    const runImmediately = vi.mocked(after).getMockImplementation();
    const capturedCallbacks: Array<() => void | Promise<void>> = [];
    vi.mocked(after).mockImplementation((task: Parameters<typeof after>[0]) => {
      capturedCallbacks.push(task as () => void | Promise<void>);
    });

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "DELETE",
    });

    let response: Awaited<ReturnType<typeof DELETE>>;
    try {
      response = await DELETE(request, {
        params: Promise.resolve({ userId: "user-1" }),
      });

      // The response resolved without deleteWorkspace having run at all — it
      // only exists inside a captured (not-yet-run) after() callback.
      expect(deleteWorkspace).not.toHaveBeenCalled();

      // Running the captured callbacks is what next/server does once the
      // response has actually been sent — this is what triggers cleanup.
      for (const cb of capturedCallbacks) {
        await cb();
      }
    } finally {
      if (runImmediately) vi.mocked(after).mockImplementation(runImmediately);
    }

    expect(response.status).toBe(200);
    expect(deleteWorkspace).toHaveBeenCalledWith("agent-1");
  });

  it("calls regenerateOpenClawConfig after deletion", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Mock: select personal agents returns one agent
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }]),
      }),
    } as never);

    // Mock: update returns the deactivated user
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1" }]),
      }),
    } as never);

    // Mock: update for personal agent soft-delete
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "DELETE",
    });

    await DELETE(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });

    expect(regenerateOpenClawConfig).toHaveBeenCalledOnce();
  });
});

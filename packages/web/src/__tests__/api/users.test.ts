import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

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

vi.mock("@/db", () => ({
  db: {
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
  },
}));

import { auth } from "@/lib/auth";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { users } from "@/db/schema";

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
        returning: vi.fn().mockResolvedValue([{ id: "user-1", email: "u@test.com" }]),
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
    expect(db.delete).not.toHaveBeenCalled();
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "user.deleted" })
    );
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

    // Mock: update for personal agent-1 soft-delete
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    } as never);

    // Mock: update for personal agent-2 soft-delete
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

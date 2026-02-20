import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/workspace", () => ({
  deleteWorkspace: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

import { auth } from "@/lib/auth";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";
import { db } from "@/db";

// ── GET /api/users ───────────────────────────────────────────────────────

describe("GET /api/users", () => {
  let GET: typeof import("@/app/api/users/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const response = await GET();
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns list of users without passwordHash", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const fakeUsers = [
      { id: "user-1", name: "Alice", email: "alice@test.com", role: "user" },
      { id: "admin-1", name: "Bob", email: "bob@test.com", role: "admin" },
    ];

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockResolvedValueOnce(fakeUsers),
    } as never);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.users).toHaveLength(2);
    expect(body.users[0].id).toBe("user-1");
    expect(body.users[0].name).toBe("Alice");
    expect(body.users[0].email).toBe("alice@test.com");
    expect(body.users[0].role).toBe("user");
    // Ensure passwordHash is NOT in the response
    expect(body.users[0]).not.toHaveProperty("passwordHash");
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
    vi.mocked(auth).mockResolvedValueOnce(null);

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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

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

  it("returns 400 when admin tries to delete themselves", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const request = new NextRequest("http://localhost:7777/api/users/admin-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "admin-1" }),
    });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Cannot delete your own account");
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    // Mock: select personal agents returns empty
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    // Mock: delete returns empty (user not found)
    vi.mocked(db.delete).mockReturnValueOnce({
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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    // Mock: select personal agents returns one agent
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }]),
      }),
    } as never);

    // Mock: delete returns the deleted user
    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1" }]),
      }),
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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    // Mock: select personal agents returns two agents
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }, { id: "agent-2" }]),
      }),
    } as never);

    // Mock: delete returns the deleted user
    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1" }]),
      }),
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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    // Mock: select personal agents returns one agent
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "agent-1" }]),
      }),
    } as never);

    // Mock: delete returns the deleted user
    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1" }]),
      }),
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

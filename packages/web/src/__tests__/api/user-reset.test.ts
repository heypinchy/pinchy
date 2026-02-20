import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/invites", () => ({
  createInvite: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  },
}));

import { auth } from "@/lib/auth";
import { createInvite } from "@/lib/invites";
import { db } from "@/db";

// ── POST /api/users/[userId]/reset ──────────────────────────────────────

describe("POST /api/users/[userId]/reset", () => {
  let POST: typeof import("@/app/api/users/[userId]/reset/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/[userId]/reset/route");
    POST = mod.POST;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/users/user-1/reset", {
      method: "POST",
    });

    const response = await POST(request, {
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

    const request = new NextRequest("http://localhost:7777/api/users/user-2/reset", {
      method: "POST",
    });

    const response = await POST(request, {
      params: Promise.resolve({ userId: "user-2" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce(undefined);

    const request = new NextRequest("http://localhost:7777/api/users/nonexistent/reset", {
      method: "POST",
    });

    const response = await POST(request, {
      params: Promise.resolve({ userId: "nonexistent" }),
    });
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("User not found");
  });

  it("returns 201 with token on success", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce({
      id: "user-1",
      name: "Alice",
      email: "alice@test.com",
      role: "user",
    });

    const fakeInvite = {
      id: "invite-1",
      email: "alice@test.com",
      role: "user",
      type: "reset",
      token: "reset-token-abc123",
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(createInvite).mockResolvedValueOnce(fakeInvite as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1/reset", {
      method: "POST",
    });

    const response = await POST(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.token).toBe("reset-token-abc123");
  });

  it("creates an invite with type 'reset' and the user's email", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce({
      id: "user-1",
      name: "Alice",
      email: "alice@test.com",
      role: "user",
    });

    const fakeInvite = {
      id: "invite-1",
      email: "alice@test.com",
      role: "user",
      type: "reset",
      token: "reset-token-abc123",
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(createInvite).mockResolvedValueOnce(fakeInvite as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1/reset", {
      method: "POST",
    });

    await POST(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });

    expect(createInvite).toHaveBeenCalledWith({
      email: "alice@test.com",
      role: "user",
      type: "reset",
      createdBy: "admin-1",
    });
  });

  it("handles user with no email (passes undefined)", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce({
      id: "user-1",
      name: "Alice",
      email: null,
      role: "user",
    });

    const fakeInvite = {
      id: "invite-1",
      email: undefined,
      role: "user",
      type: "reset",
      token: "reset-token-abc123",
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(createInvite).mockResolvedValueOnce(fakeInvite as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1/reset", {
      method: "POST",
    });

    await POST(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });

    expect(createInvite).toHaveBeenCalledWith({
      email: undefined,
      role: "user",
      type: "reset",
      createdBy: "admin-1",
    });
  });
});

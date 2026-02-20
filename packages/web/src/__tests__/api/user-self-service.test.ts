import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn().mockResolvedValue("new_hashed_password"),
  },
}));

vi.mock("@/db", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  },
}));

import { auth } from "@/lib/auth";
import { db } from "@/db";
import bcrypt from "bcryptjs";

// ── PATCH /api/users/me ─────────────────────────────────────────────────

describe("PATCH /api/users/me", () => {
  let PATCH: typeof import("@/app/api/users/me/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/me/route");
    PATCH = mod.PATCH;
  });

  function makeRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost:7777/api/users/me", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null);

    const request = makeRequest({ name: "New Name" });

    const response = await PATCH(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when name is empty", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const request = makeRequest({ name: "" });

    const response = await PATCH(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Name is required");
  });

  it("returns 400 when name is whitespace only", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const request = makeRequest({ name: "   " });

    const response = await PATCH(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Name is required");
  });

  it("returns 200 and updates user name on success", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const request = makeRequest({ name: "Updated Name" });

    const response = await PATCH(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify db.update was called
    expect(db.update).toHaveBeenCalled();
  });

  it("trims the name before saving", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const request = makeRequest({ name: "  Trimmed Name  " });

    const response = await PATCH(request);
    expect(response.status).toBe(200);

    // Verify the set() call received the trimmed name
    const setFn = vi.mocked(db.update("" as never).set);
    expect(setFn).toHaveBeenCalledWith({ name: "Trimmed Name" });
  });
});

// ── POST /api/users/me/password ─────────────────────────────────────────

describe("POST /api/users/me/password", () => {
  let POST: typeof import("@/app/api/users/me/password/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/me/password/route");
    POST = mod.POST;
  });

  function makeRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost:7777/api/users/me/password", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null);

    const request = makeRequest({
      currentPassword: "old123456",
      newPassword: "new123456",
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when currentPassword is missing", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const request = makeRequest({ newPassword: "new123456" });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Current password is required");
  });

  it("returns 400 when newPassword is too short (< 8)", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const request = makeRequest({
      currentPassword: "old123456",
      newPassword: "short",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("New password must be at least 8 characters");
  });

  it("returns 403 when currentPassword is incorrect", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce({
      id: "user-1",
      email: "user@test.com",
      name: "Test User",
      emailVerified: null,
      image: null,
      passwordHash: "existing_hash",
      role: "user",
    });

    vi.mocked(bcrypt.compare).mockResolvedValueOnce(false as never);

    const request = makeRequest({
      currentPassword: "wrongpassword",
      newPassword: "new123456",
    });

    const response = await POST(request);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Current password is incorrect");
  });

  it("returns 200 and updates password on success", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce({
      id: "user-1",
      email: "user@test.com",
      name: "Test User",
      emailVerified: null,
      image: null,
      passwordHash: "existing_hash",
      role: "user",
    });

    vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);

    const request = makeRequest({
      currentPassword: "old123456",
      newPassword: "new123456",
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify bcrypt.hash was called with the new password and 12 salt rounds
    expect(bcrypt.hash).toHaveBeenCalledWith("new123456", 12);

    // Verify db.update was called
    expect(db.update).toHaveBeenCalled();
  });

  it("returns 401 when user has no passwordHash", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce({
      id: "user-1",
      email: "user@test.com",
      name: "Test User",
      emailVerified: null,
      image: null,
      passwordHash: null,
      role: "user",
    });

    const request = makeRequest({
      currentPassword: "old123456",
      newPassword: "new123456",
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });
});

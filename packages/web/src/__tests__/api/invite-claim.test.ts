import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/invites", () => ({
  validateInviteToken: vi.fn(),
  claimInvite: vi.fn(),
}));

vi.mock("@/lib/personal-agent", () => ({
  seedPersonalAgent: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("hashed_password_123"),
  },
}));

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "new-user-id",
            email: "invited@test.com",
            name: "New User",
            role: "user",
          },
        ]),
      }),
    }),
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

import { validateInviteToken, claimInvite } from "@/lib/invites";
import { seedPersonalAgent } from "@/lib/personal-agent";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import bcrypt from "bcryptjs";

// ── POST /api/invite/claim ───────────────────────────────────────────────

describe("POST /api/invite/claim", () => {
  let POST: typeof import("@/app/api/invite/claim/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/invite/claim/route");
    POST = mod.POST;
  });

  function makeRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost:7777/api/invite/claim", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // ── Validation ──────────────────────────────────────────────────────

  it("returns 400 when token is missing", async () => {
    const request = makeRequest({ name: "Test User", password: "password123" });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Token is required");
  });

  it("returns 400 when password is missing", async () => {
    const request = makeRequest({ token: "valid-token", name: "Test User" });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Password must be at least 8 characters");
  });

  it("returns 400 when password is too short", async () => {
    const request = makeRequest({ token: "valid-token", name: "Test User", password: "short" });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Password must be at least 8 characters");
  });

  it("returns 410 when token is expired, invalid, or already claimed", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce(null);

    const request = makeRequest({ token: "bad-token", name: "Test User", password: "password123" });

    const response = await POST(request);
    expect(response.status).toBe(410);

    const body = await response.json();
    expect(body.error).toBe("Invalid or expired invite link");
  });

  it("returns 400 when name is missing for new user invite", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce({
      id: "invite-1",
      tokenHash: "hash123",
      email: "invited@test.com",
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
    });

    const request = makeRequest({ token: "valid-token", password: "password123" });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Name is required");
  });

  // ── Successful new user invite ──────────────────────────────────────

  it("returns 201 and creates user on success", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce({
      id: "invite-1",
      tokenHash: "hash123",
      email: "invited@test.com",
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
    });

    const request = makeRequest({
      token: "valid-token",
      name: "New User",
      password: "password123",
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify bcrypt was called with 12 salt rounds
    expect(bcrypt.hash).toHaveBeenCalledWith("password123", 12);

    // Verify user was inserted with correct data
    expect(db.insert).toHaveBeenCalled();
    const valuesFn = vi.mocked(db.insert("" as never).values);
    expect(valuesFn).toHaveBeenCalledWith({
      email: "invited@test.com",
      name: "New User",
      passwordHash: "hashed_password_123",
      role: "user",
    });
  });

  it("seeds a personal agent for the new user on success", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce({
      id: "invite-1",
      tokenHash: "hash123",
      email: "invited@test.com",
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
    });

    const request = makeRequest({
      token: "valid-token",
      name: "New User",
      password: "password123",
    });

    await POST(request);

    expect(seedPersonalAgent).toHaveBeenCalledWith("new-user-id", false);
  });

  it("marks the invite as claimed with the new user's id", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce({
      id: "invite-1",
      tokenHash: "hash123",
      email: "invited@test.com",
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
    });

    const request = makeRequest({
      token: "valid-token",
      name: "New User",
      password: "password123",
    });

    await POST(request);

    expect(claimInvite).toHaveBeenCalledWith("hash123", "new-user-id");
  });

  it("calls regenerateOpenClawConfig on success", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce({
      id: "invite-1",
      tokenHash: "hash123",
      email: "invited@test.com",
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
    });

    const request = makeRequest({
      token: "valid-token",
      name: "New User",
      password: "password123",
    });

    await POST(request);

    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  // ── Password reset (type "reset") ──────────────────────────────────

  it("updates existing user's password for reset type", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce({
      id: "invite-2",
      tokenHash: "reset-hash",
      email: "existing@test.com",
      role: "user",
      type: "reset",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
    });

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce({
      id: "existing-user-id",
      email: "existing@test.com",
      name: "Existing User",
      emailVerified: null,
      image: null,
      passwordHash: "old_hash",
      role: "user",
    });

    const request = makeRequest({
      token: "reset-token",
      password: "newpassword123",
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify password was updated
    expect(db.update).toHaveBeenCalled();
    expect(claimInvite).toHaveBeenCalledWith("reset-hash", "existing-user-id");
  });

  it("does NOT create a personal agent for password reset", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce({
      id: "invite-2",
      tokenHash: "reset-hash",
      email: "existing@test.com",
      role: "user",
      type: "reset",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
    });

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce({
      id: "existing-user-id",
      email: "existing@test.com",
      name: "Existing User",
      emailVerified: null,
      image: null,
      passwordHash: "old_hash",
      role: "user",
    });

    const request = makeRequest({
      token: "reset-token",
      password: "newpassword123",
    });

    await POST(request);

    expect(seedPersonalAgent).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("returns 404 when user not found for password reset", async () => {
    vi.mocked(validateInviteToken).mockResolvedValueOnce({
      id: "invite-2",
      tokenHash: "reset-hash",
      email: "nonexistent@test.com",
      role: "user",
      type: "reset",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
    });

    vi.mocked(db.query.users.findFirst).mockResolvedValueOnce(undefined);

    const request = makeRequest({
      token: "reset-token",
      password: "newpassword123",
    });

    const response = await POST(request);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("User not found");
  });

  // ── No authentication required ─────────────────────────────────────

  it("does not require authentication (no auth check)", async () => {
    // This test verifies that the endpoint works without any session/auth.
    // If auth were required, validateInviteToken wouldn't be reached.
    vi.mocked(validateInviteToken).mockResolvedValueOnce(null);

    const request = makeRequest({
      token: "some-token",
      name: "User",
      password: "password123",
    });

    const response = await POST(request);
    // We get 410 (token invalid), not 401 (unauthorized) — proving no auth check
    expect(response.status).toBe(410);
    expect(validateInviteToken).toHaveBeenCalledWith("some-token");
  });
});

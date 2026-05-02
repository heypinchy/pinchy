import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn();
  const mockChangePassword = vi.fn();
  return {
    // `getSession` is the standalone helper used by `withAuth` from `@/lib/api-auth`.
    // `auth.api.getSession` is the underlying Better Auth method, kept for tests
    // that exercise the route directly. Both share the same mock so `mockResolvedValueOnce`
    // calls applied via either alias continue to work.
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
        changePassword: mockChangePassword,
      },
    },
  };
});

import { auth } from "@/lib/auth";

// ── Helpers ──────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/users/me/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("POST /api/users/me/password", () => {
  let POST: typeof import("@/app/api/users/me/password/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/me/password/route");
    POST = mod.POST;

    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
      expires: "",
    } as any);
    vi.mocked(auth.api.changePassword).mockResolvedValue(undefined as any);
  });

  it("should return 401 when unauthenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null as any);

    const response = await POST(makePostRequest({}));
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("should return 400 when currentPassword is missing", async () => {
    const response = await POST(makePostRequest({ newPassword: "newpass123" }));
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Current password is required");
  });

  it("should return 400 when newPassword is too short", async () => {
    const response = await POST(
      makePostRequest({ currentPassword: "oldpass123", newPassword: "short" })
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("New password must be at least 8 characters");
  });

  it("should return 400 when newPassword is missing", async () => {
    const response = await POST(makePostRequest({ currentPassword: "oldpass123" }));
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("New password must be at least 8 characters");
  });

  it("should return 403 when current password is incorrect", async () => {
    vi.mocked(auth.api.changePassword).mockRejectedValueOnce(new Error("Invalid credentials"));

    const response = await POST(
      makePostRequest({ currentPassword: "wrongpass", newPassword: "newpass123" })
    );
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Current password is incorrect");
  });

  it("should return 200 on successful password change", async () => {
    const response = await POST(
      makePostRequest({ currentPassword: "oldpass123", newPassword: "newpass123" })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(auth.api.changePassword).toHaveBeenCalled();
  });

  it("should accept valid passwords with exactly 8 characters", async () => {
    const response = await POST(
      makePostRequest({ currentPassword: "oldpass123", newPassword: "newpass12" })
    );
    expect(response.status).toBe(200);
  });
});

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
        changePassword: vi.fn(),
      },
    },
  };
});

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
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = makeRequest({ name: "New Name" });

    const response = await PATCH(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when name is empty", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = makeRequest({ name: "" });

    const response = await PATCH(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Name is required");
  });

  it("returns 400 when name is whitespace only", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = makeRequest({ name: "   " });

    const response = await PATCH(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Name is required");
  });

  it("returns 200 and updates user name on success", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = makeRequest({ name: "Updated Name" });

    const response = await PATCH(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify db.update was called
    expect(db.update).toHaveBeenCalled();
  });

  it("trims the name before saving", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

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
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = makeRequest({
      currentPassword: "oldpass1234567",
      newPassword: "Br1ghtNova!2",
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when currentPassword is missing", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = makeRequest({ newPassword: "Br1ghtNova!2" });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Current password is required");
  });

  it("returns 400 when newPassword is too short (< 12)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = makeRequest({
      currentPassword: "oldpass1234567",
      newPassword: "short",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Password must be at least 12 characters");
  });

  it("returns 400 when newPassword has no digit (closes 8-char downgrade gap)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = makeRequest({
      currentPassword: "oldpass1234567",
      newPassword: "abcdefghijkl",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Password must contain at least one letter and one number");
  });

  it("returns 400 when newPassword is in the common-password list", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = makeRequest({
      currentPassword: "oldpass1234567",
      newPassword: "password1234",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Password is too common. Please choose a less predictable one.");
  });

  it("returns 403 when currentPassword is incorrect", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    vi.mocked((auth.api as any).changePassword).mockRejectedValueOnce(
      new Error("Invalid password")
    );

    const request = makeRequest({
      currentPassword: "wrongpassword1",
      newPassword: "Br1ghtNova!2",
    });

    const response = await POST(request);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Current password is incorrect");
  });

  it("returns 200 and updates password on success", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    vi.mocked((auth.api as any).changePassword).mockResolvedValueOnce({});

    const request = makeRequest({
      currentPassword: "oldpass1234567",
      newPassword: "Br1ghtNova!2",
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify auth.api.changePassword was called with the correct arguments
    expect((auth.api as any).changePassword).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          currentPassword: "oldpass1234567",
          newPassword: "Br1ghtNova!2",
          revokeOtherSessions: false,
        },
      })
    );
  });

  it("returns 403 when changePassword throws (e.g., no password set)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    vi.mocked((auth.api as any).changePassword).mockRejectedValueOnce(
      new Error("Password not set")
    );

    const request = makeRequest({
      currentPassword: "oldpass1234567",
      newPassword: "Br1ghtNova!2",
    });

    const response = await POST(request);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Current password is incorrect");
  });
});

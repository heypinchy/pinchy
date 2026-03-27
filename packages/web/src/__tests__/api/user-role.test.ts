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

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));

// Mock modules that the existing DELETE handler imports
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/workspace", () => ({
  deleteWorkspace: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

const mockUpdateReturning = vi.fn();
const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

const mockSelectWhere = vi.fn();
const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
const mockSelectFields = vi.fn().mockReturnValue({ from: mockSelectFrom });

vi.mock("@/db", () => ({
  db: {
    select: mockSelectFields,
    update: mockUpdate,
  },
}));

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

import { auth } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";

// ── PATCH /api/users/[userId] ────────────────────────────────────────────

describe("PATCH /api/users/[userId]", () => {
  let PATCH: typeof import("@/app/api/users/[userId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/[userId]/route");
    PATCH = mod.PATCH;
  });

  it("returns 401 when not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 400 when role is invalid", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "PATCH",
      body: JSON.stringify({ role: "superadmin" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 when trying to change own role", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/admin-1", {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ userId: "admin-1" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("own role");
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // User lookup returns empty
    mockSelectWhere.mockResolvedValueOnce([]);

    const request = new NextRequest("http://localhost:7777/api/users/nonexistent", {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ userId: "nonexistent" }),
    });
    expect(response.status).toBe(404);
  });

  it("returns 400 when demoting last admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // User lookup: target is an admin
    mockSelectWhere.mockResolvedValueOnce([{ id: "admin-2", name: "Other Admin", role: "admin" }]);

    // Admin count query: only 1 active admin
    mockSelectWhere.mockResolvedValueOnce([{ count: 1 }]);

    const request = new NextRequest("http://localhost:7777/api/users/admin-2", {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ userId: "admin-2" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("last admin");
  });

  it("successfully updates role and logs audit event", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // User lookup
    mockSelectWhere.mockResolvedValueOnce([{ id: "user-1", name: "Max", role: "member" }]);

    // Update returns the updated user
    mockUpdateReturning.mockResolvedValueOnce([{ id: "user-1", name: "Max", role: "admin" }]);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "user.role_updated",
        resource: "user:user-1",
        detail: { changes: { role: { from: "member", to: "admin" } }, userName: "Max" },
      })
    );
  });
});

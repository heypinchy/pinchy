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

const mockIsEnterprise = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/enterprise", () => ({
  isEnterprise: mockIsEnterprise,
}));

const mockReturning = vi.fn();
const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

const mockSelectWhere = vi.fn();
const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
const mockSelectFields = vi.fn().mockReturnValue({ from: mockSelectFrom });

const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

vi.mock("@/db", () => ({
  db: {
    select: mockSelectFields,
    insert: mockInsert,
    delete: mockDelete,
  },
}));

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

import { auth } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";

// ── PUT /api/users/[userId]/groups ──────────────────────────────────────

describe("PUT /api/users/[userId]/groups", () => {
  let PUT: typeof import("@/app/api/users/[userId]/groups/route").PUT;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDeleteWhere.mockResolvedValue(undefined);
    mockIsEnterprise.mockResolvedValue(true);
    // Default: user exists (first select call), groups exist (second), previous memberships (third)
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([{ id: "g1", name: "Engineering" }]) // group names
      .mockResolvedValueOnce([]); // previous memberships
    const mod = await import("@/app/api/users/[userId]/groups/route");
    PUT = mod.PUT;
  });

  it("returns 403 when not enterprise", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    mockIsEnterprise.mockResolvedValueOnce(false);

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Enterprise feature");
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 403 when not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(403);
  });

  it("returns 400 when groupIds is not an array", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: "not-an-array" }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("groupIds must be an array");
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Override: user does not exist
    mockSelectWhere.mockReset();
    mockSelectWhere.mockResolvedValueOnce([]); // user lookup returns empty

    const request = new NextRequest("http://localhost:7777/api/users/nonexistent/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "nonexistent" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("User not found");
  });

  it("deletes existing groups and inserts new ones", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Reset and set up mocks for this specific test
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([{ groupId: "g3" }]) // previous memberships
      .mockResolvedValueOnce([
        { id: "g1", name: "Engineering" },
        { id: "g2", name: "Marketing" },
        { id: "g3", name: "Design" },
      ]); // all relevant group names (new + removed)

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1", "g2"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // Should delete existing memberships
    expect(mockDelete).toHaveBeenCalled();
    // Should insert new ones
    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith([
      { userId: "user-1", groupId: "g1" },
      { userId: "user-1", groupId: "g2" },
    ]);
  });

  it("logs audit event with added/removed group names", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Reset and set up mocks
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([{ groupId: "g2" }]) // previous memberships (g2 will be removed)
      .mockResolvedValueOnce([
        { id: "g1", name: "Engineering" },
        { id: "g2", name: "Marketing" },
        { id: "g3", name: "Design" },
      ]); // all relevant group names (new + removed)

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1", "g3"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "user.groups_updated",
        resource: "user:user-1",
        detail: {
          userName: "Max Müller",
          added: [
            { id: "g1", name: "Engineering" },
            { id: "g3", name: "Design" },
          ],
          removed: [{ id: "g2", name: "Marketing" }],
          memberCount: 2,
        },
      })
    );
  });

  it("handles empty groupIds (remove all groups, no insert)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Reset and set up mocks
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([]) // no new group names (empty groupIds)
      .mockResolvedValueOnce([{ groupId: "g1" }]); // previous memberships

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: [] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(200);

    // Should delete but not insert
    expect(mockDelete).toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

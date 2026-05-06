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

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
}));

const mockReturning = vi.fn();
const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

const mockSelectGroupBy = vi.fn();
const mockSelectLeftJoin = vi.fn().mockReturnValue({ groupBy: mockSelectGroupBy });
const mockSelectWhere = vi.fn();
const mockSelectFrom = vi
  .fn()
  .mockReturnValue({ leftJoin: mockSelectLeftJoin, where: mockSelectWhere });
const mockSelectFields = vi.fn().mockReturnValue({ from: mockSelectFrom });

const mockUpdateReturning = vi.fn();
const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

const mockDeleteReturning = vi.fn();
const mockDeleteWhere = vi.fn().mockReturnValue({ returning: mockDeleteReturning });
const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

vi.mock("@/db", () => ({
  db: {
    select: mockSelectFields,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

import { auth } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";

// ── GET /api/groups ──────────────────────────────────────────────────────

describe("GET /api/groups", () => {
  let GET: typeof import("@/app/api/groups/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/groups/route");
    GET = mod.GET;
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const response = await GET();
    expect(response.status).toBe(403);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns groups with member count for admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeGroups = [
      {
        id: "group-1",
        name: "Engineering",
        description: "Dev team",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        memberCount: 3,
      },
    ];
    mockSelectGroupBy.mockResolvedValueOnce(fakeGroups);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Engineering");
    expect(body[0].memberCount).toBe(3);
  });
});

// ── POST /api/groups ─────────────────────────────────────────────────────

describe("POST /api/groups", () => {
  let POST: typeof import("@/app/api/groups/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/groups/route");
    POST = mod.POST;
  });

  it("creates group for admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeGroup = {
      id: "group-new",
      name: "Marketing",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockReturning.mockResolvedValueOnce([fakeGroup]);

    const request = new NextRequest("http://localhost:7777/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Marketing" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.name).toBe("Marketing");

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "group.created",
        resource: "group:group-new",
      })
    );
  });

  it("rejects missing name", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.name).toBeDefined();
  });

  it("rejects empty name", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.name).toBeDefined();
  });

  it("accepts description: null from the client and creates the group", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeGroup = {
      id: "group-new",
      name: "Engineering",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockReturning.mockResolvedValueOnce([fakeGroup]);

    const request = new NextRequest("http://localhost:7777/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Engineering", description: null }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.name).toBe("Engineering");
    expect(body.description).toBeNull();
  });

  it("rejects non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Marketing" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
  });
});

// ── PATCH /api/groups/[groupId] ──────────────────────────────────────────

describe("PATCH /api/groups/[groupId]", () => {
  let PATCH: typeof import("@/app/api/groups/[groupId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/groups/[groupId]/route");
    PATCH = mod.PATCH;
  });

  it("updates group name for admin with from/to audit detail", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const existingGroup = {
      id: "group-1",
      name: "Old Name",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // First call: select existing group
    mockSelectWhere.mockResolvedValueOnce([existingGroup]);

    const updatedGroup = {
      id: "group-1",
      name: "New Name",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockUpdateReturning.mockResolvedValueOnce([updatedGroup]);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.name).toBe("New Name");

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "group.updated",
        resource: "group:group-1",
        detail: {
          changes: {
            name: { from: "Old Name", to: "New Name" },
          },
        },
      })
    );
  });

  it("updates group description with from/to audit detail", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const existingGroup = {
      id: "group-1",
      name: "Engineering",
      description: "Old description",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockSelectWhere.mockResolvedValueOnce([existingGroup]);

    const updatedGroup = {
      id: "group-1",
      name: "Engineering",
      description: "New description",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockUpdateReturning.mockResolvedValueOnce([updatedGroup]);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1", {
      method: "PATCH",
      body: JSON.stringify({ description: "New description" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "group.updated",
        resource: "group:group-1",
        detail: {
          changes: {
            description: { from: "Old description", to: "New description" },
          },
        },
      })
    );
  });

  it("does not log audit when no fields actually changed", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const existingGroup = {
      id: "group-1",
      name: "Same Name",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockSelectWhere.mockResolvedValueOnce([existingGroup]);

    const updatedGroup = { ...existingGroup };
    mockUpdateReturning.mockResolvedValueOnce([updatedGroup]);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Same Name" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(200);

    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("rejects empty name", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "   " }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Name cannot be empty");
  });

  it("returns 404 for unknown group", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Select returns empty — group not found
    mockSelectWhere.mockResolvedValueOnce([]);

    const request = new NextRequest("http://localhost:7777/api/groups/nonexistent", {
      method: "PATCH",
      body: JSON.stringify({ name: "Foo" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ groupId: "nonexistent" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Group not found");
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Foo" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(403);
  });
});

// ── DELETE /api/groups/[groupId] ─────────────────────────────────────────

describe("DELETE /api/groups/[groupId]", () => {
  let DELETE: typeof import("@/app/api/groups/[groupId]/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/groups/[groupId]/route");
    DELETE = mod.DELETE;
  });

  it("deletes group for admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockDeleteReturning.mockResolvedValueOnce([{ id: "group-1", name: "Old Group" }]);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "group.deleted",
        resource: "group:group-1",
        detail: { name: "Old Group" },
      })
    );
  });

  it("returns 404 for unknown group", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockDeleteReturning.mockResolvedValueOnce([]);

    const request = new NextRequest("http://localhost:7777/api/groups/nonexistent", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ groupId: "nonexistent" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Group not found");
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(403);
  });
});

// ── PUT /api/groups/[groupId]/members ────────────────────────────────────

describe("PUT /api/groups/[groupId]/members", () => {
  let PUT: typeof import("@/app/api/groups/[groupId]/members/route").PUT;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset delete mock for members route (it doesn't use returning)
    mockDeleteWhere.mockResolvedValue(undefined);
    mockReturning.mockResolvedValue([]);
    // Default: group exists
    mockSelectWhere.mockResolvedValue([{ id: "group-1" }]);
    const mod = await import("@/app/api/groups/[groupId]/members/route");
    PUT = mod.PUT;
  });

  it("replaces member list for admin with added/removed diff", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // 1st select: group exists check
    mockSelectWhere.mockResolvedValueOnce([{ id: "group-1" }]);
    // 2nd select: existing members (user-old is currently a member)
    mockSelectWhere.mockResolvedValueOnce([{ userId: "user-old", groupId: "group-1" }]);
    // 3rd select: resolve user names for changed users (user-1, user-2 added; user-old removed)
    mockSelectWhere.mockResolvedValueOnce([
      { id: "user-1", name: "User One" },
      { id: "user-2", name: "User Two" },
      { id: "user-old", name: "Old User" },
    ]);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1/members", {
      method: "PUT",
      body: JSON.stringify({ userIds: ["user-1", "user-2"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // Should delete existing memberships
    expect(mockDelete).toHaveBeenCalled();
    // Should insert new ones
    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith([
      { userId: "user-1", groupId: "group-1" },
      { userId: "user-2", groupId: "group-1" },
    ]);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "group.members_updated",
        resource: "group:group-1",
        detail: {
          added: [
            { id: "user-1", name: "User One" },
            { id: "user-2", name: "User Two" },
          ],
          removed: [{ id: "user-old", name: "Old User" }],
          memberCount: 2,
        },
      })
    );
  });

  it("logs only removals when members are removed", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // 1st select: group exists check
    mockSelectWhere.mockResolvedValueOnce([{ id: "group-1" }]);
    // 2nd select: existing members
    mockSelectWhere.mockResolvedValueOnce([
      { userId: "user-1", groupId: "group-1" },
      { userId: "user-2", groupId: "group-1" },
    ]);
    // 3rd select: resolve user names for removed users
    mockSelectWhere.mockResolvedValueOnce([{ id: "user-2", name: "User Two" }]);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1/members", {
      method: "PUT",
      body: JSON.stringify({ userIds: ["user-1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "group.members_updated",
        resource: "group:group-1",
        detail: {
          added: [],
          removed: [{ id: "user-2", name: "User Two" }],
          memberCount: 1,
        },
      })
    );
  });

  it("rejects userIds with non-string elements", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1/members", {
      method: "PUT",
      body: JSON.stringify({ userIds: [123, null] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors).toBeDefined();
  });

  it("returns 404 when group does not exist", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // Mock the group lookup to return empty (group does not exist)
    mockSelectWhere.mockResolvedValueOnce([]);

    const request = new NextRequest("http://localhost:7777/api/groups/nonexistent/members", {
      method: "PUT",
      body: JSON.stringify({ userIds: ["user-1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ groupId: "nonexistent" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Group not found");
  });

  it("rejects non-array userIds", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1/members", {
      method: "PUT",
      body: JSON.stringify({ userIds: "not-an-array" }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.userIds).toBeDefined();
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1/members", {
      method: "PUT",
      body: JSON.stringify({ userIds: ["user-1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(403);
  });

  it("handles empty userIds array (removes all members)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // 1st select: group exists check
    mockSelectWhere.mockResolvedValueOnce([{ id: "group-1" }]);
    // 2nd select: existing members
    mockSelectWhere.mockResolvedValueOnce([{ userId: "user-1", groupId: "group-1" }]);
    // 3rd select: resolve user names for removed user
    mockSelectWhere.mockResolvedValueOnce([{ id: "user-1", name: "User One" }]);

    const request = new NextRequest("http://localhost:7777/api/groups/group-1/members", {
      method: "PUT",
      body: JSON.stringify({ userIds: [] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ groupId: "group-1" }),
    });
    expect(response.status).toBe(200);

    // Should delete but not insert
    expect(mockDelete).toHaveBeenCalled();
    // insert should not be called for empty array
    expect(mockInsert).not.toHaveBeenCalled();

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          added: [],
          removed: [{ id: "user-1", name: "User One" }],
          memberCount: 0,
        },
      })
    );
  });
});

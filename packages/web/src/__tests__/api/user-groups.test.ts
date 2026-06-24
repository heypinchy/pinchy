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

// db.transaction(cb) runs cb with a tx reusing the delete/insert mocks, so the
// route's atomic wipe+insert is exercised and existing assertions still hold.
const mockTransaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
  cb({ delete: mockDelete, insert: mockInsert })
);

vi.mock("@/db", () => ({
  db: {
    select: mockSelectFields,
    insert: mockInsert,
    delete: mockDelete,
    transaction: (cb: (tx: unknown) => unknown) => mockTransaction(cb),
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
    // Re-establish the transaction runner cleared by clearAllMocks.
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ delete: mockDelete, insert: mockInsert })
    );
    // Default: user exists (first select call), groups exist (second), previous memberships (third)
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([{ id: "g1", name: "Engineering" }]) // group names
      .mockResolvedValueOnce([]); // previous memberships
    const mod = await import("@/app/api/users/[userId]/groups/route");
    PUT = mod.PUT;
  });

  it("replaces group memberships atomically inside a single transaction", async () => {
    // The wipe + re-insert must commit or roll back together; otherwise an
    // insert failure leaves the user stripped of all groups with none re-added.
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    // Select order in the route: user lookup → previous memberships → group names.
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user exists
      .mockResolvedValueOnce([]) // no previous memberships
      .mockResolvedValueOnce([{ id: "g1", name: "Engineering" }]); // requested group exists

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1"] }),
    });
    await PUT(request, { params: Promise.resolve({ userId: "user-1" }) });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it("returns a structured 403 when adding groups without an active license", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    mockIsEnterprise.mockResolvedValueOnce(false);

    // user-1 currently has no groups — adding g1 would widen nothing but
    // creates a new restriction-bearing membership, which is gated. g1 is a
    // real group, so it passes the existence check and reaches the license gate.
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([]) // previous memberships (none)
      .mockResolvedValueOnce([{ id: "g1", name: "Engineering" }]); // group names — g1 exists

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("License required");
    expect(body.message).toMatch(/Removing users from groups always works/);
  });

  it("returns 400 (not an FK 500) and skips the wipe when a groupId does not exist", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([]) // previous memberships
      .mockResolvedValueOnce([]); // group names — the requested group is unknown

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["ghost-group"] }),
    });
    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });

    expect(response.status).toBe(400);
    // The membership wipe must not run on invalid input.
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it("allows removal-only updates without an active license (carve-out, § 5)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    mockIsEnterprise.mockResolvedValue(false);

    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([{ groupId: "g1" }, { groupId: "g2" }]) // previous memberships
      .mockResolvedValueOnce([
        { id: "g1", name: "Engineering" },
        { id: "g2", name: "Marketing" },
      ]); // group names

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: ["g1"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith([{ userId: "user-1", groupId: "g1" }]);
  });

  it("allows removing all groups without an active license", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    mockIsEnterprise.mockResolvedValue(false);

    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: "user-1", name: "Max Müller" }]) // user lookup
      .mockResolvedValueOnce([{ groupId: "g1" }]) // previous memberships
      .mockResolvedValueOnce([{ id: "g1", name: "Engineering" }]); // group names

    const request = new NextRequest("http://localhost:7777/api/users/user-1/groups", {
      method: "PUT",
      body: JSON.stringify({ groupIds: [] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
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
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.groupIds).toBeDefined();
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

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

vi.mock("@/lib/invites", () => ({
  createInvite: vi.fn(),
}));

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    appendAuditLog: vi.fn().mockResolvedValue(undefined),
  };
});

// Default to inactive license so existing tests are unaffected by seat-cap logic
vi.mock("@/lib/enterprise", () => ({
  getLicenseStatus: vi.fn().mockResolvedValue({
    active: false,
    ver: 1,
    maxUsers: 0,
    features: [],
  }),
}));

vi.mock("@/lib/seat-usage", () => ({
  getSeatUsage: vi.fn(),
}));

vi.mock("@/db", () => {
  const mockFrom = vi.fn().mockImplementation(() => {
    const result = Promise.resolve([]);
    (result as any).innerJoin = vi.fn().mockResolvedValue([]);
    (result as any).where = vi.fn().mockResolvedValue([]);
    return result;
  });
  return {
    db: {
      query: {
        invites: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      select: vi.fn().mockReturnValue({
        from: mockFrom,
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    },
  };
});

import { auth } from "@/lib/auth";
import { createInvite } from "@/lib/invites";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";

// ── POST /api/users/invite ───────────────────────────────────────────────

describe("POST /api/users/invite", () => {
  let POST: typeof import("@/app/api/users/invite/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("AUDIT_HMAC_SECRET", "f".repeat(64));
    const mod = await import("@/app/api/users/invite/route");
    POST = mod.POST;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({ role: "member" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user role is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({ role: "member" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 400 when role is missing", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Role must be 'admin' or 'member'");
  });

  it("returns 400 when role is invalid", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({ role: "superadmin" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Role must be 'admin' or 'member'");
  });

  it("returns 201 with invite data on success", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeInvite = {
      id: "invite-1",
      email: "newuser@test.com",
      role: "member",
      type: "invite",
      token: "abc123",
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(createInvite).mockResolvedValueOnce(fakeInvite as never);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({ email: "newuser@test.com", role: "member" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.id).toBe("invite-1");
    expect(body.email).toBe("newuser@test.com");
    expect(body.token).toBe("abc123");

    expect(createInvite).toHaveBeenCalledWith({
      email: "newuser@test.com",
      role: "member",
      createdBy: "admin-1",
    });
  });

  it("succeeds without email (email is optional)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeInvite = {
      id: "invite-2",
      role: "member",
      type: "invite",
      token: "def456",
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(createInvite).mockResolvedValueOnce(fakeInvite as never);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({ role: "member" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.id).toBe("invite-2");

    expect(createInvite).toHaveBeenCalledWith({
      email: undefined,
      role: "member",
      createdBy: "admin-1",
    });
  });

  it("passes groupIds to createInvite when provided", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeInvite = {
      id: "invite-3",
      email: "grouped@test.com",
      role: "member",
      type: "invite",
      token: "group-token",
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(createInvite).mockResolvedValueOnce(fakeInvite as never);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({
        email: "grouped@test.com",
        role: "member",
        groupIds: ["group-1", "group-2"],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    expect(createInvite).toHaveBeenCalledWith({
      email: "grouped@test.com",
      role: "member",
      createdBy: "admin-1",
      groupIds: ["group-1", "group-2"],
    });
  });

  it("logs group names instead of IDs in audit detail", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeInvite = {
      id: "invite-4",
      email: "grouped@test.com",
      role: "member",
      type: "invite",
      token: "group-token",
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(createInvite).mockResolvedValueOnce(fakeInvite as never);

    const mockWhere = vi.fn().mockResolvedValueOnce([
      { id: "group-1", name: "Engineering" },
      { id: "group-2", name: "Marketing" },
    ]);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: mockWhere }),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({
        email: "grouped@test.com",
        role: "member",
        groupIds: ["group-1", "group-2"],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "user.invited",
      outcome: "success",
      detail: {
        emailHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        emailPreview: "gr…ed@test.com",
        role: "member",
        groups: [
          { id: "group-1", name: "Engineering" },
          { id: "group-2", name: "Marketing" },
        ],
      },
    });
  });

  it("omits groups from audit detail when no groupIds provided", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeInvite = {
      id: "invite-5",
      email: "solo@test.com",
      role: "member",
      type: "invite",
      token: "solo-token",
      createdAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(createInvite).mockResolvedValueOnce(fakeInvite as never);

    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({
        email: "solo@test.com",
        role: "member",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "user.invited",
      outcome: "success",
      detail: {
        emailHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        emailPreview: "solo@test.com",
        role: "member",
      },
    });
  });
});

// ── GET /api/users/invites ───────────────────────────────────────────────

describe("GET /api/users/invites", () => {
  let GET: typeof import("@/app/api/users/invites/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/invites/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user role is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const response = await GET();
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns list of invites without tokenHash", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeInvites = [
      {
        id: "invite-1",
        email: "user1@test.com",
        role: "member",
        type: "invite",
        createdAt: new Date("2026-01-01"),
        expiresAt: new Date("2026-01-08"),
        claimedAt: null,
        inviteGroups: [],
      },
      {
        id: "invite-2",
        email: null,
        role: "admin",
        type: "invite",
        createdAt: new Date("2026-01-02"),
        expiresAt: new Date("2026-01-09"),
        claimedAt: null,
        inviteGroups: [],
      },
    ];

    vi.mocked(db.query.invites.findMany).mockResolvedValueOnce(fakeInvites as never);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.invites).toHaveLength(2);
    expect(body.invites[0].id).toBe("invite-1");
    expect(body.invites[0].email).toBe("user1@test.com");
    // Ensure tokenHash is NOT in the response
    expect(body.invites[0]).not.toHaveProperty("tokenHash");
  });

  it("returns each invite's groups via the relational query builder", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const fakeInvites = [
      {
        id: "invite-1",
        email: "user1@test.com",
        role: "member",
        type: "invite",
        createdAt: new Date("2026-01-01"),
        expiresAt: new Date("2026-01-08"),
        claimedAt: null,
        inviteGroups: [
          { group: { id: "g1", name: "Engineering" } },
          { group: { id: "g2", name: "Design" } },
        ],
      },
    ];

    vi.mocked(db.query.invites.findMany).mockResolvedValueOnce(fakeInvites as never);

    const response = await GET();
    const body = await response.json();
    expect(body.invites[0].groups).toEqual([
      { id: "g1", name: "Engineering" },
      { id: "g2", name: "Design" },
    ]);
  });
});

// ── DELETE /api/users/invites/[inviteId] ─────────────────────────────────

describe("DELETE /api/users/invites/[inviteId]", () => {
  let DELETE: typeof import("@/app/api/users/invites/[inviteId]/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/users/invites/[inviteId]/route");
    DELETE = mod.DELETE;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/users/invites/invite-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ inviteId: "invite-1" }),
    });
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user role is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/users/invites/invite-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ inviteId: "invite-1" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 404 when invite not found", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/invites/nonexistent", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ inviteId: "nonexistent" }),
    });
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("Invite not found");
  });

  it("returns 200 on successful deletion", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "invite-1" }]),
      }),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/invites/invite-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ inviteId: "invite-1" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
  });
});

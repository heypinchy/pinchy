import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
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

vi.mock("@/lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents")>();
  return {
    ...actual,
    deleteAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Test Agent" }),
    updateAgent: vi.fn(),
  };
});

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db", () => {
  const mockInsertValues = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([]),
  });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  // Default chainable select (for group name lookups etc.)
  const defaultSelect = () => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });

  return {
    db: {
      insert: mockInsert,
      select: vi.fn().mockImplementation(defaultSelect),
      delete: mockDelete,
    },
  };
});

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return {
    ...actual,
    activeAgents: actual.activeAgents,
  };
});

vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeWorkspaceFileInternal: vi.fn(),
  writeIdentityFile: vi.fn(),
}));

vi.mock("@/lib/context-sync", () => ({
  getContextForAgent: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/lib/path-validation", () => ({
  validateAllowedPaths: vi.fn((paths: string[]) =>
    paths.map((p) => (p.endsWith("/") ? p : p + "/"))
  ),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("anthropic"),
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
}));

import { auth } from "@/lib/auth";
import { updateAgent } from "@/lib/agents";
import { db } from "@/db";

function mockAgent(agent: Record<string, unknown> | undefined) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(agent ? [agent] : []),
    }),
  } as never);
}

// ── PATCH /api/agents/[agentId] — visibility ─────────────────────────────

describe("PATCH /api/agents/[agentId] visibility", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("admin can set visibility to 'all'", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({ id: "agent-1", name: "Test Agent", isPersonal: false, ownerId: null });

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      visibility: "all",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ visibility: "all" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith("agent-1", { visibility: "all" });
  });

  it("admin can set visibility to 'restricted' with groupIds", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({ id: "agent-1", name: "Test Agent", isPersonal: false, ownerId: null });

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      visibility: "restricted",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ visibility: "restricted", groupIds: ["group-1", "group-2"] }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    // Should delete old group assignments and insert new ones
    expect(db.delete).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
  });

  it("non-admin cannot change visibility (403)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    mockAgent({ id: "agent-1", name: "Test Agent", isPersonal: false, ownerId: null });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ visibility: "all" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(403);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("invalid visibility value returns 400", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({ id: "agent-1", name: "Test Agent", isPersonal: false, ownerId: null });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ visibility: "invalid_value" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid visibility value");
  });

  it("cannot change visibility on personal agents (400)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({ id: "agent-1", name: "My Agent", isPersonal: true, ownerId: "admin-1" });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ visibility: "all" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Cannot change visibility for personal agents");
  });

  it("setting groupIds updates agent_groups table", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({ id: "agent-1", name: "Test Agent", isPersonal: false, ownerId: null });

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ groupIds: ["group-a"] }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    // Should have deleted old assignments
    expect(db.delete).toHaveBeenCalled();
    // Should have inserted new assignment
    expect(db.insert).toHaveBeenCalled();
  });
});

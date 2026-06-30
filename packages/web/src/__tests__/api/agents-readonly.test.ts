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
  getLicenseState: vi.fn().mockResolvedValue("paid"),
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

// ── PATCH /api/agents/[agentId] — readOnly ────────────────────────────────

describe("PATCH /api/agents/[agentId] readOnly", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("admin can enable read-only mode on a shared agent", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    mockAgent({ id: "agent-1", name: "My Agent", isPersonal: false, ownerId: "admin-1" });

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "My Agent",
      readOnly: true,
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ readOnly: true }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(response.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith("agent-1", { readOnly: true });
  });

  it("non-admin cannot change read-only mode (403)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);
    mockAgent({ id: "agent-1", name: "My Agent", isPersonal: false, ownerId: "admin-1" });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ readOnly: true }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(response.status).toBe(403);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("cannot change read-only mode on personal agents (400)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    mockAgent({ id: "agent-1", name: "My Agent", isPersonal: true, ownerId: "admin-1" });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ readOnly: true }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(response.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });
});

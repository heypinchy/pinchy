import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
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

vi.mock("@/lib/workspace", () => ({
  writeIdentityFile: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return {
    ...actual,
    activeAgents: actual.activeAgents,
  };
});

import { auth } from "@/lib/auth";
import { deleteAgent, updateAgent } from "@/lib/agents";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

function mockAgent(agent: Record<string, unknown> | undefined) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(agent ? [agent] : []),
    }),
  } as never);
}

// ── GET /api/agents/[agentId] ────────────────────────────────────────────

describe("GET /api/agents/[agentId]", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/route").GET;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1");
    const response = await GET(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns agent when authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      isPersonal: false,
      ownerId: null,
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1");
    const response = await GET(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.name).toBe("Test Agent");
  });

  it("returns 403 when non-owner user tries to access personal agent of another user", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-2", role: "member" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Personal Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      isPersonal: true,
      ownerId: "user-1",
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1");
    const response = await GET(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });
});

// ── PATCH /api/agents/[agentId] ─────────────────────────────────────────

describe("PATCH /api/agents/[agentId]", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("updates agent when authenticated as admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      isPersonal: false,
      ownerId: null,
    });

    const { updateAgent } = await import("@/lib/agents");
    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "New Name",
      model: "anthropic/claude-sonnet-4-20250514",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.name).toBe("New Name");
  });

  it("returns 403 when non-owner user tries to update personal agent of another user", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-2", role: "member" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Personal Agent",
      isPersonal: true,
      ownerId: "user-1",
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 404 when agent not found for update", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    mockAgent(undefined);

    const request = new NextRequest("http://localhost:7777/api/agents/nonexistent", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "nonexistent" }),
    });
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("Agent not found");
  });

  it("admin can update allowedTools for shared agent", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
      ownerId: null,
    });

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      allowedTools: ["odoo_read", "pinchy_ls"],
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["odoo_read", "pinchy_ls"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      allowedTools: ["odoo_read", "pinchy_ls"],
    });
  });

  it("returns 403 when non-admin tries to modify shared agent", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
      ownerId: null,
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["odoo_read"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 400 when trying to update allowedTools for personal agent", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Personal Agent",
      isPersonal: true,
      ownerId: "admin-1",
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["odoo_read"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Cannot change permissions for personal agents");
  });

  it("does not call regenerateOpenClawConfig directly (updateAgent handles it)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
      ownerId: null,
    });

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "New Name",
      model: "anthropic/claude-sonnet-4-20250514",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("admin can update pluginConfig for shared agent", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
      ownerId: null,
    });

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/"] } },
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({
        pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/"] } },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/"] } },
    });
  });

  it("should update greeting message", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      isPersonal: false,
      ownerId: null,
    });

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      greetingMessage: "Hello!",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ greetingMessage: "Hello!" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      greetingMessage: "Hello!",
    });
  });

  it("should reject clearing greeting message with null (NOT NULL at schema level)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      isPersonal: false,
      ownerId: null,
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ greetingMessage: null }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("should reject clearing greeting message with empty string", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      isPersonal: false,
      ownerId: null,
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ greetingMessage: "   " }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });
});

// ── DELETE /api/agents/[agentId] ─────────────────────────────────────────

describe("DELETE /api/agents/[agentId]", () => {
  let DELETE: typeof import("@/app/api/agents/[agentId]/route").DELETE;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    DELETE = mod.DELETE;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 400 when admin tries to delete their own personal agent", async () => {
    // Owner === actor: assertAgentAccess passes (admin owns this personal agent),
    // then the route's isPersonal guard fires with a clear product message.
    // This is the documented "personal agents cannot be deleted" rule and must
    // remain reachable after the security fix that put the privacy check first.
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Personal Agent",
      isPersonal: true,
      ownerId: "admin-1",
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Personal agents cannot be deleted");
  });

  it("returns 403 when admin tries to delete another user's personal agent", async () => {
    // After the security fix: admins cannot access personal agents owned by other users.
    // The isPersonal privacy check runs before the admin fast-path, so the route
    // returns 403 (access denied) rather than 400 (personal agents cannot be deleted).
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Personal Agent",
      isPersonal: true,
      ownerId: "other-user",
    });

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 404 when agent not found", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent(undefined);

    const request = new NextRequest("http://localhost:7777/api/agents/nonexistent", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ agentId: "nonexistent" }),
    });
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("Agent not found");
  });

  it("returns 200 on successful deletion", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    mockAgent({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
    });

    vi.mocked(deleteAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);

    expect(deleteAgent).toHaveBeenCalledWith("agent-1");
  });
});

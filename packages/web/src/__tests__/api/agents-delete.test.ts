import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

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
    query: {
      agents: {
        findFirst: vi.fn(),
      },
    },
  },
}));

import { auth } from "@/lib/auth";
import { deleteAgent, updateAgent } from "@/lib/agents";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

// ── GET /api/agents/[agentId] ────────────────────────────────────────────

describe("GET /api/agents/[agentId]", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/route").GET;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1");
    const response = await GET(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns agent when authenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      isPersonal: false,
      ownerId: null,
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1");
    const response = await GET(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.name).toBe("Test Agent");
  });

  it("returns 403 when non-owner user tries to access personal agent of another user", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-2", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Personal Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      isPersonal: true,
      ownerId: "user-1",
    } as never);

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
    vi.mocked(auth).mockResolvedValueOnce(null);

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

  it("updates agent when authenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      isPersonal: false,
      ownerId: null,
    } as never);

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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-2", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Personal Agent",
      isPersonal: true,
      ownerId: "user-1",
    } as never);

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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce(undefined);

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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
      ownerId: null,
    } as never);

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      allowedTools: ["shell", "pinchy_ls"],
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["shell", "pinchy_ls"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      allowedTools: ["shell", "pinchy_ls"],
    });
  });

  it("returns 403 when non-admin tries to update allowedTools", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
      ownerId: null,
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["shell"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Only admins can change permissions");
  });

  it("returns 400 when trying to update allowedTools for personal agent", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Personal Agent",
      isPersonal: true,
      ownerId: "admin-1",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["shell"] }),
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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
      ownerId: null,
    } as never);

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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
      ownerId: null,
    } as never);

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      pluginConfig: { allowed_paths: ["/data/docs/"] },
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ pluginConfig: { allowed_paths: ["/data/docs/"] } }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      pluginConfig: { allowed_paths: ["/data/docs/"] },
    });
  });

  it("should update greeting message", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      isPersonal: false,
      ownerId: null,
    } as never);

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

  it("should allow clearing greeting message with null", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      isPersonal: false,
      ownerId: null,
    } as never);

    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      model: "anthropic/claude-sonnet-4-20250514",
      greetingMessage: null,
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ greetingMessage: null }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      greetingMessage: null,
    });
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
    vi.mocked(auth).mockResolvedValueOnce(null);

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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "user" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

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

  it("returns 400 when agent is a personal agent", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Personal Agent",
      isPersonal: true,
    } as never);

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

  it("returns 404 when agent not found", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce(undefined);

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
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      name: "Shared Agent",
      isPersonal: false,
    } as never);

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

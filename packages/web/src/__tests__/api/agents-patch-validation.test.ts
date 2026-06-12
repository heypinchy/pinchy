import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/lib/audit", () => ({ appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn();
  return { getSession: mockGetSession, auth: { api: { getSession: mockGetSession } } };
});
vi.mock("@/lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents")>();
  return { ...actual, updateAgent: vi.fn() };
});
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeWorkspaceFileInternal: vi.fn(),
  writeIdentityFile: vi.fn(),
}));
vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(false),
  getLicenseState: vi.fn().mockResolvedValue("community"),
}));
vi.mock("@/lib/provider-models", () => ({
  fetchProviderModels: vi.fn().mockResolvedValue([
    {
      id: "ollama-cloud",
      name: "Ollama Cloud",
      models: [
        { id: "ollama-cloud/qwen3-vl:235b", name: "qwen3-vl:235b" },
        {
          id: "ollama-cloud/no-tools-model",
          name: "no-tools-model",
          compatible: false,
          incompatibleReason: "Not compatible — does not support agent tools",
        },
      ],
    },
  ]),
}));
vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })),
  },
}));
vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

import { auth } from "@/lib/auth";
import { fetchProviderModels } from "@/lib/provider-models";
import { updateAgent } from "@/lib/agents";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

function mockAgent(agent: Record<string, unknown>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([agent]),
    }),
  } as never);
}

function adminSession() {
  vi.mocked(auth.api.getSession).mockResolvedValueOnce({
    user: { id: "user-1", role: "admin" },
    expires: "",
  } as never);
}

describe("PATCH /api/agents/[agentId] — pluginConfig validation", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("rejects a non-object pluginConfig (array)", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Test Agent", model: "m", isPersonal: false, ownerId: null });

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ pluginConfig: ["not", "an", "object"] }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.pluginConfig).toBeDefined();
  });

  it("rejects invalid domains in pluginConfig['pinchy-web'].allowedDomains", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Test Agent", model: "m", isPersonal: false, ownerId: null });

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({
        pluginConfig: { "pinchy-web": { allowedDomains: ["not a domain!!!"] } },
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/domain/i);
  });

  it("rejects invalid domains in pluginConfig['pinchy-web'].excludedDomains", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Test Agent", model: "m", isPersonal: false, ownerId: null });

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({
        pluginConfig: { "pinchy-web": { excludedDomains: ["@#$%"] } },
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/domain/i);
  });

  it("accepts valid pluginConfig with valid domains", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Test Agent", model: "m", isPersonal: false, ownerId: null });

    const validConfig = { "pinchy-web": { allowedDomains: ["example.com", "docs.github.com"] } };
    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      pluginConfig: validConfig,
    } as never);

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ pluginConfig: validConfig }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(200);
  });

  it("rejects pinchy-files.allowed_paths that is not a string array", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Test Agent", model: "m", isPersonal: false, ownerId: null });

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({
        pluginConfig: { "pinchy-files": { allowed_paths: 42 } },
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.pluginConfig).toBeDefined();
  });

  it("rejects pinchy-files.allowed_paths with non-string entries", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Test Agent", model: "m", isPersonal: false, ownerId: null });

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({
        pluginConfig: { "pinchy-files": { allowed_paths: ["/data/", 123] } },
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  it("rejects empty-string name on PATCH", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Test Agent", model: "m", isPersonal: false, ownerId: null });

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.name).toBeDefined();
  });

  it("rejects whitespace-only name on PATCH", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Test Agent", model: "m", isPersonal: false, ownerId: null });

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "   " }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.name).toBeDefined();
  });

  it("calls regenerateOpenClawConfig when allowedTools changes", async () => {
    adminSession();
    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      model: "m",
      isPersonal: false,
      ownerId: null,
      allowedTools: [],
    });
    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      allowedTools: ["pinchy_write"],
    } as never);

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["pinchy_write"] }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(200);
    expect(vi.mocked(regenerateOpenClawConfig)).toHaveBeenCalled();
  });

  it("does not call regenerateOpenClawConfig when only name changes", async () => {
    adminSession();
    mockAgent({
      id: "agent-1",
      name: "Old Name",
      model: "m",
      isPersonal: false,
      ownerId: null,
      allowedTools: [],
    });
    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "New Name",
      allowedTools: [],
    } as never);

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(200);
    expect(vi.mocked(regenerateOpenClawConfig)).not.toHaveBeenCalled();
  });

  it("accepts null pluginConfig (clears config)", async () => {
    adminSession();
    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      model: "m",
      isPersonal: false,
      ownerId: null,
      pluginConfig: { "pinchy-web": {} },
    });

    vi.mocked(updateAgent).mockResolvedValueOnce({ id: "agent-1", pluginConfig: null } as never);

    const req = new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ pluginConfig: null }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/agents/[agentId] — model validation against configured providers", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  function patchRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("rejects a model whose provider is not configured with a structured 400", async () => {
    adminSession();
    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      model: "ollama-cloud/qwen3-vl:235b",
      isPersonal: false,
      ownerId: null,
    });

    const res = await PATCH(patchRequest({ model: "anthropic/claude-sonnet-4-6" }), {
      params: Promise.resolve({ agentId: "agent-1" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("anthropic/claude-sonnet-4-6");
    expect(body.error).toContain("not available");
    expect(vi.mocked(updateAgent)).not.toHaveBeenCalled();
  });

  it("rejects a model the provider lists as incompatible", async () => {
    adminSession();
    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      model: "ollama-cloud/qwen3-vl:235b",
      isPersonal: false,
      ownerId: null,
    });

    const res = await PATCH(patchRequest({ model: "ollama-cloud/no-tools-model" }), {
      params: Promise.resolve({ agentId: "agent-1" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("does not support agent tools");
    expect(vi.mocked(updateAgent)).not.toHaveBeenCalled();
  });

  it("accepts a model of a configured provider", async () => {
    adminSession();
    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      model: "ollama-cloud/old-model",
      isPersonal: false,
      ownerId: null,
    });
    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      model: "ollama-cloud/qwen3-vl:235b",
    } as never);

    const res = await PATCH(patchRequest({ model: "ollama-cloud/qwen3-vl:235b" }), {
      params: Promise.resolve({ agentId: "agent-1" }),
    });

    expect(res.status).toBe(200);
  });

  it("does not validate when the PATCH leaves the model untouched — a name-only update on an agent with a legacy model of a disconnected provider must succeed", async () => {
    adminSession();
    mockAgent({
      id: "agent-1",
      name: "Old Name",
      model: "google/gemini-2.5-flash",
      isPersonal: false,
      ownerId: null,
    });
    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "New Name",
      model: "google/gemini-2.5-flash",
    } as never);

    const res = await PATCH(patchRequest({ name: "New Name" }), {
      params: Promise.resolve({ agentId: "agent-1" }),
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(fetchProviderModels)).not.toHaveBeenCalled();
  });

  it("does not validate when the PATCH resends the agent's current model unchanged", async () => {
    adminSession();
    mockAgent({
      id: "agent-1",
      name: "Test Agent",
      model: "google/gemini-2.5-flash",
      isPersonal: false,
      ownerId: null,
    });
    vi.mocked(updateAgent).mockResolvedValueOnce({
      id: "agent-1",
      name: "Test Agent",
      model: "google/gemini-2.5-flash",
    } as never);

    const res = await PATCH(patchRequest({ model: "google/gemini-2.5-flash" }), {
      params: Promise.resolve({ agentId: "agent-1" }),
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(fetchProviderModels)).not.toHaveBeenCalled();
  });
});

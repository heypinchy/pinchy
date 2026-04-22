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
vi.mock("@/lib/enterprise", () => ({ isEnterprise: vi.fn().mockResolvedValue(false) }));
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
import { updateAgent } from "@/lib/agents";
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
    expect(body.error).toMatch(/pluginConfig/i);
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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({
  deleteAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Test Agent" }),
  updateAgent: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "new-agent-id",
            name: "Test Agent",
            model: "anthropic/claude-haiku-4-5-20251001",
            templateId: "custom",
            pluginConfig: null,
            ownerId: "user-1",
          },
        ]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    }),
    query: {
      agents: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));

vi.mock("@/lib/path-validation", () => ({
  validateAllowedPaths: vi.fn((paths: string[]) =>
    paths.map((p) => (p.endsWith("/") ? p : p + "/"))
  ),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("anthropic"),
}));

import { auth } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { deleteAgent, updateAgent } from "@/lib/agents";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

// ── POST /api/agents — agent.created audit ──────────────────────────────

describe("POST /api/agents audit logging", () => {
  let POST: typeof import("@/app/api/agents/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-1", email: "admin@test.com", role: "admin" },
      expires: "",
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
    const mod = await import("@/app/api/agents/route");
    POST = mod.POST;
  });

  it("calls appendAuditLog with agent.created after creating an agent", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Agent",
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.created",
      resource: "agent:new-agent-id",
      detail: {
        name: "Test Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        templateId: "custom",
      },
    });
  });
});

// ── PATCH /api/agents/[agentId] — agent.updated audit ───────────────────

describe("PATCH /api/agents/[agentId] audit logging", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("calls appendAuditLog with agent.updated after updating an agent", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "admin" },
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
      name: "Updated Agent",
      model: "anthropic/claude-sonnet-4-20250514",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Updated Agent", model: "anthropic/claude-sonnet-4-20250514" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.updated",
      resource: "agent:agent-1",
      detail: { changes: ["name", "model"] },
    });
  });
});

// ── DELETE /api/agents/[agentId] — agent.deleted audit ──────────────────

describe("DELETE /api/agents/[agentId] audit logging", () => {
  let DELETE: typeof import("@/app/api/agents/[agentId]/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    DELETE = mod.DELETE;
  });

  it("calls appendAuditLog with agent.deleted after deleting an agent", async () => {
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

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "agent.deleted",
      resource: "agent:agent-1",
      detail: { name: "Shared Agent" },
    });
  });
});

// ── PATCH /api/agents/[agentId] — config regeneration ─────────────────

describe("PATCH /api/agents/[agentId] config regeneration", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("should not call regenerateOpenClawConfig directly when allowedTools change (updateAgent handles it)", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "user-1", role: "admin" },
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
      allowedTools: ["shell"],
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["shell"] }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);

    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });
});

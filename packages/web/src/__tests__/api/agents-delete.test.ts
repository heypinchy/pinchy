import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({
  deleteAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Test Agent" }),
  updateAgent: vi.fn(),
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
import { deleteAgent } from "@/lib/agents";
import { db } from "@/db";

// ── DELETE /api/agents/[agentId] ─────────────────────────────────────────

describe("DELETE /api/agents/[agentId]", () => {
  let DELETE: typeof import("@/app/api/agents/[agentId]/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi
    .fn()
    .mockResolvedValue({ user: { id: "user-1", email: "user@test.com", role: "member" } });
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

const mockGetAgentWithAccess = vi.fn();

vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: (...args: unknown[]) => mockGetAgentWithAccess(...args),
}));

import { getSession } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { POST } from "@/app/api/internal/audit/background-run/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/internal/audit/background-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/audit/background-run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    } as Awaited<ReturnType<typeof getSession>>);
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
  });

  it("returns 401 when the user is not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: 1500 }));

    expect(res.status).toBe(401);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent does not exist or is not owned by the user", async () => {
    mockGetAgentWithAccess.mockResolvedValue(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: 1500 }));

    expect(res.status).toBe(404);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 204 and writes a chat.background_run_completed audit log on success", async () => {
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });

    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: 1500 }));

    expect(res.status).toBe(204);
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      eventType: "chat.background_run_completed",
      resource: "agent:agent-1",
      detail: { agent: { id: "agent-1", name: "Smithers" }, durationMs: 1500 },
      outcome: "success",
    });
  });

  it("returns 400 when agentId is missing", async () => {
    const res = await POST(makeRequest({ durationMs: 500 }));

    expect(res.status).toBe(400);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 when durationMs is not a number", async () => {
    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: "notanumber" }));

    expect(res.status).toBe(400);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 when durationMs is negative", async () => {
    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: -1 }));

    expect(res.status).toBe(400);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 when durationMs exceeds 10 minutes (telemetry sanity bound)", async () => {
    const tenMinutesPlusOne = 10 * 60 * 1000 + 1;
    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: tenMinutesPlusOne }));

    expect(res.status).toBe(400);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("accepts durationMs at exactly 10 minutes (boundary)", async () => {
    const tenMinutes = 10 * 60 * 1000;
    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: tenMinutes }));

    expect(res.status).toBe(204);
    expect(appendAuditLog).toHaveBeenCalled();
  });
});

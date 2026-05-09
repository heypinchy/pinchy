import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
  });

  it("returns 401 when the user is not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: 1500 }));

    expect(res.status).toBe(401);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 204 and writes a chat.background_run_completed audit log on success", async () => {
    const res = await POST(makeRequest({ agentId: "agent-1", durationMs: 1500 }));

    expect(res.status).toBe(204);
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      eventType: "chat.background_run_completed",
      resource: "agent:agent-1",
      detail: { agentId: "agent-1", durationMs: 1500 },
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
});

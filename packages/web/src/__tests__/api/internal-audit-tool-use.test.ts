import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { appendAuditLog } from "@/lib/audit";
import { POST } from "@/app/api/internal/audit/tool-use/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/internal/audit/tool-use", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer gw-token",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/audit/tool-use", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
  });

  it("returns 401 when gateway token is invalid", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await POST(
      makeRequest({
        phase: "start",
        toolName: "pinchy_read",
        agentId: "agent-1",
      })
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid payload", async () => {
    const res = await POST(
      makeRequest({
        phase: "middle",
        toolName: 123,
        agentId: "agent-1",
      })
    );

    expect(res.status).toBe(400);
  });

  it("writes tool.execute start audit events", async () => {
    const res = await POST(
      makeRequest({
        phase: "start",
        toolName: "pinchy_read",
        agentId: "agent-1",
        runId: "run-1",
        toolCallId: "tool-1",
        sessionKey: "agent:agent-1:user-user-1",
        sessionId: "session-1",
        params: { path: "/data/policy.md" },
      })
    );

    expect(res.status).toBe(200);
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: "agent-1",
      eventType: "tool.execute",
      resource: "agent:agent-1",
      detail: {
        toolName: "pinchy_read",
        phase: "start",
        runId: "run-1",
        toolCallId: "tool-1",
        sessionKey: "agent:agent-1:user-user-1",
        sessionId: "session-1",
        params: { path: "/data/policy.md" },
        source: "openclaw_hook",
      },
    });
  });

  it("writes tool.execute end audit events", async () => {
    const res = await POST(
      makeRequest({
        phase: "end",
        toolName: "browser",
        agentId: "agent-2",
        runId: "run-2",
        toolCallId: "tool-2",
        sessionKey: "agent:agent-2:user-user-1",
        sessionId: "session-2",
        result: { ok: true },
        error: "none",
        durationMs: 123,
      })
    );

    expect(res.status).toBe(200);
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: "agent-2",
      eventType: "tool.execute",
      resource: "agent:agent-2",
      detail: {
        toolName: "browser",
        phase: "end",
        runId: "run-2",
        toolCallId: "tool-2",
        sessionKey: "agent:agent-2:user-user-1",
        sessionId: "session-2",
        result: { ok: true },
        error: "none",
        durationMs: 123,
        source: "openclaw_hook",
      },
    });
  });

  it("derives actorId from sessionKey when agentId is omitted", async () => {
    const res = await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_read",
        sessionKey: "agent:derived-agent-id:main",
        result: "ok",
      })
    );

    expect(res.status).toBe(200);
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: "derived-agent-id",
      eventType: "tool.execute",
      resource: "agent:derived-agent-id",
      detail: {
        toolName: "pinchy_read",
        phase: "end",
        sessionKey: "agent:derived-agent-id:main",
        result: "ok",
        source: "openclaw_hook",
      },
    });
  });

  it("uses unknown-agent fallback when neither agentId nor sessionKey are present", async () => {
    const res = await POST(
      makeRequest({
        phase: "start",
        toolName: "browser",
        params: { action: "open" },
      })
    );

    expect(res.status).toBe(200);
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: "unknown-agent",
      eventType: "tool.execute",
      resource: "agent:unknown-agent",
      detail: {
        toolName: "browser",
        phase: "start",
        params: { action: "open" },
        source: "openclaw_hook",
      },
    });
  });
});

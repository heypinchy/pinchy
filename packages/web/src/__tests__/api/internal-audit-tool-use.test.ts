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

  // Change 1: start phase is skipped — no audit log entry written
  it("returns 200 and does not write an audit log entry for start phase", async () => {
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
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  // Change 2: eventType becomes tool.<toolName>
  it("uses tool.<toolName> as eventType for end phase", async () => {
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
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "tool.browser",
      })
    );
  });

  it("uses tool.<toolName> as eventType with different tool names", async () => {
    await POST(
      makeRequest({
        phase: "end",
        toolName: "WebFetch",
        agentId: "agent-3",
        result: "fetched",
      })
    );

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "tool.WebFetch",
      })
    );
  });

  // Change 3: actor becomes the user extracted from sessionKey
  it("uses user as actorType and extracts userId from sessionKey", async () => {
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
      actorType: "user",
      actorId: "user-1",
      eventType: "tool.browser",
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

  it("falls back to agent actorType when sessionKey has no user portion", async () => {
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
      eventType: "tool.pinchy_read",
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
        phase: "end",
        toolName: "browser",
        params: { action: "open" },
        result: "done",
      })
    );

    expect(res.status).toBe(200);
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: "unknown-agent",
      eventType: "tool.browser",
      resource: "agent:unknown-agent",
      detail: {
        toolName: "browser",
        phase: "end",
        params: { action: "open" },
        result: "done",
        source: "openclaw_hook",
      },
    });
  });

  it("returns 500 with error message when appendAuditLog fails", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("DB connection lost"));

    const res = await POST(
      makeRequest({
        phase: "end",
        toolName: "browser",
        agentId: "agent-1",
        result: "ok",
      })
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Audit logging failed");
  });

  describe("sensitive data sanitization", () => {
    it("redacts sensitive key names in params before logging", async () => {
      await POST(
        makeRequest({
          phase: "end",
          toolName: "http_request",
          agentId: "agent-1",
          params: { url: "https://api.example.com", apiKey: "sk-live-abc123" },
          result: "ok",
        })
      );

      const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
      const detail = call?.detail as Record<string, unknown>;
      const params = detail?.params as Record<string, unknown>;
      expect(params.apiKey).toBe("[REDACTED]");
      expect(params.url).toBe("https://api.example.com");
    });

    it("redacts secret patterns in result strings before logging", async () => {
      await POST(
        makeRequest({
          phase: "end",
          toolName: "pinchy_read",
          agentId: "agent-1",
          result: "Found key: sk-abcdefghijklmnopqrstuvwxyz in config",
        })
      );

      const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
      const detail = call?.detail as Record<string, unknown>;
      expect(detail?.result).toContain("[REDACTED]");
      expect(detail?.result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    });

    it("redacts env-file content in result strings", async () => {
      await POST(
        makeRequest({
          phase: "end",
          toolName: "pinchy_read",
          agentId: "agent-1",
          result: "API_KEY=my-secret-key\nAPP_NAME=pinchy",
        })
      );

      const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
      const detail = call?.detail as Record<string, unknown>;
      expect(detail?.result).toContain("API_KEY=[REDACTED]");
      expect(detail?.result).toContain("APP_NAME=pinchy");
    });
  });
});

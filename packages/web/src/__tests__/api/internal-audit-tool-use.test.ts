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
        sessionKey: "agent:agent-1:direct:user-1",
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
        sessionKey: "agent:agent-2:direct:user-1",
        sessionId: "session-2",
        result: { ok: true },
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
        sessionKey: "agent:agent-2:direct:user-1",
        sessionId: "session-2",
        result: { ok: true },
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
        success: true,
        durationMs: 123,
      },
      outcome: "success",
      error: null,
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
        success: true,
      },
      outcome: "success",
      error: null,
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
        success: true,
        params: { action: "open" },
      },
      outcome: "success",
      error: null,
    });
  });

  it("derives outcome='success' and error=null when payload has no error", async () => {
    await POST(
      makeRequest({
        phase: "end",
        toolName: "web_search",
        agentId: "agent-1",
        result: { hits: 3 },
      })
    );

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        error: null,
      })
    );
  });

  it("derives outcome='failure' and error.message from payload.error", async () => {
    await POST(
      makeRequest({
        phase: "end",
        toolName: "web_search",
        agentId: "agent-1",
        error: "Brave API key missing",
      })
    );

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        error: { message: "Brave API key missing" },
      })
    );
  });

  it("derives outcome='failure' when result.isError is true (MCP convention)", async () => {
    // MCP tools signal semantic failures by returning isError: true on the
    // result object instead of throwing. Example: pinchy_read returning
    // { isError: true, content: [{ type: "text", text: "ENOENT: ..." }] }.
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_read",
        agentId: "agent-1",
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "ENOENT: no such file or directory, realpath '/data/holidays.md'",
            },
          ],
        },
      })
    );

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        error: { message: "ENOENT: no such file or directory, realpath '/data/holidays.md'" },
      })
    );
  });

  it("payload.error takes precedence over result.isError", async () => {
    // If OpenClaw's hook reports a transport-level error AND the result has
    // isError, the transport error wins because it's the more fundamental
    // failure.
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_read",
        agentId: "agent-1",
        error: "Plugin crashed",
        result: { isError: true, content: [{ type: "text", text: "inner" }] },
      })
    );

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        error: { message: "Plugin crashed" },
      })
    );
  });

  it("detail.error reflects transport error, not semantic error, when both are present", async () => {
    // Transport precedence must propagate into detail.error too — otherwise
    // the audit row's error column and detail JSON disagree.
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_read",
        agentId: "agent-1",
        error: "Plugin crashed",
        result: { isError: true, content: [{ type: "text", text: "inner semantic message" }] },
      })
    );

    const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
    const detail = call?.detail as Record<string, unknown>;
    expect(detail.success).toBe(false);
    expect(detail.error).toBe("Plugin crashed");
  });

  it("detail.error reflects transport error even when plugin supplies result.details.error", async () => {
    // Transport precedence must also win over plugin-supplied result.details.error.
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_write",
        agentId: "agent-1",
        error: "Plugin crashed",
        result: {
          isError: true,
          content: [{ type: "text", text: "inner semantic message" }],
          details: { path: "notiz.txt", error: "plugin-curated message" },
        },
      })
    );

    const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
    const detail = call?.detail as Record<string, unknown>;
    expect(detail.success).toBe(false);
    expect(detail.error).toBe("Plugin crashed");
  });

  it("non-string result.details.error is replaced by semantic message", async () => {
    // The audit error column expects a string. If a plugin supplies a
    // structured (non-string) error inside result.details, the endpoint must
    // fall back to the semantic text-content message so detail.error remains
    // a string and consumers don't have to special-case shapes.
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_write",
        agentId: "agent-1",
        result: {
          isError: true,
          content: [{ type: "text", text: "File already exists" }],
          details: {
            path: "notiz.txt",
            error: { code: 42, message: "structured plugin error" },
          },
        },
      })
    );

    const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
    const detail = call?.detail as Record<string, unknown>;
    expect(detail.success).toBe(false);
    expect(typeof detail.error).toBe("string");
    expect(detail.error).toBe("File already exists");
  });

  it("result.isError=true without content falls back to a generic message", async () => {
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_read",
        agentId: "agent-1",
        result: { isError: true },
      })
    );

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        error: { message: "Tool returned an error" },
      })
    );
  });

  it("detail.success and detail.error stay consistent with outcome when result.isError=true", async () => {
    // Issue #404: pinchy_write returns { isError: true, content, details } on
    // EEXIST. The endpoint must keep detail.success aligned with outcome and
    // surface the error inside detail too, otherwise the audit detail JSON
    // contradicts the failure outcome (success: true with no error field).
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_write",
        agentId: "agent-1",
        params: {
          path: "/workspace/notiz.txt",
          content: "secret content",
          overwrite: false,
        },
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "File already exists at /workspace/notiz.txt. Set overwrite=true to replace.",
            },
          ],
          details: {
            path: "notiz.txt",
            mode: "create",
            overwrite: false,
            error: "File already exists",
          },
        },
      })
    );

    const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
    expect(call?.outcome).toBe("failure");
    expect(call?.error).toEqual({
      message: "File already exists at /workspace/notiz.txt. Set overwrite=true to replace.",
    });
    const detail = call?.detail as Record<string, unknown>;
    expect(detail.success).toBe(false);
    expect(typeof detail.error).toBe("string");
    expect(detail.error).toMatch(/File already exists/);
    expect(detail.path).toBe("notiz.txt");
    expect(detail.toolName).toBe("pinchy_write");
    // params must still be suppressed (PII protection via details override).
    expect(detail).not.toHaveProperty("params");
  });

  it("derives outcome='failure' from result.details.error when result.isError is missing (defense-in-depth)", async () => {
    // Issue #404 root cause: OpenClaw's tool-use audit hook strips the MCP
    // `isError: true` flag from the result before posting to /api/internal/
    // audit/tool-use, so the only failure signal Pinchy receives is the
    // plugin's curated `details.error` string. Observed on staging v0.5.4:
    // every failed `pinchy_write` (ENOENT, "Access denied: path not in
    // write_paths", etc.) was recorded as `outcome: success` with a green
    // checkmark, even though detail.error contained the failure message —
    // a CISO-blocking inconsistency.
    //
    // Defense: when `details.error` is a non-empty string, treat it as a
    // failure signal even if `result.isError` is absent. This lets Pinchy
    // surface plugin-curated semantic errors correctly without waiting on
    // the upstream OpenClaw hook to forward `isError`.
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_write",
        agentId: "agent-1",
        params: { path: "/workspace/uploads/test.txt", content: "x", overwrite: true },
        result: {
          // No isError — simulating the OC-hook-strips-isError case.
          content: [
            {
              type: "text",
              text: "ENOENT: no such file or directory, open " + "'/workspace/uploads/test.txt'",
            },
          ],
          details: {
            path: "/workspace/uploads/test.txt",
            overwrite: true,
            error: "ENOENT: no such file or directory, open " + "'/workspace/uploads/test.txt'",
          },
        },
      })
    );

    const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
    expect(call?.outcome).toBe("failure");
    expect(call?.error?.message).toMatch(/ENOENT/);
    const detail = call?.detail as Record<string, unknown>;
    expect(detail.success).toBe(false);
    expect(detail.error).toMatch(/ENOENT/);
  });

  it("empty-string result.details.error is NOT treated as a failure signal", async () => {
    // Guard against false-positive failure derivation: an empty
    // `details.error` (some plugins emit `""` to mean "no error") must not
    // flip outcome to failure. Only meaningful (non-empty) strings count.
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_write",
        agentId: "agent-1",
        result: {
          content: [{ type: "text", text: "Wrote 5 bytes" }],
          details: { path: "/workspace/uploads/x.txt", error: "" },
        },
      })
    );

    const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
    expect(call?.outcome).toBe("success");
    const detail = call?.detail as Record<string, unknown>;
    expect(detail.success).toBe(true);
  });

  it("detail.success=false and detail.error set when result.isError=true without details", async () => {
    // No result.details override — endpoint must still mark detail.success
    // as false and lift the semantic error message into detail.error.
    await POST(
      makeRequest({
        phase: "end",
        toolName: "pinchy_read",
        agentId: "agent-1",
        params: { path: "/data/missing.md" },
        result: {
          isError: true,
          content: [{ type: "text", text: "ENOENT: no such file or directory" }],
        },
      })
    );

    const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
    const detail = call?.detail as Record<string, unknown>;
    expect(detail.success).toBe(false);
    expect(detail.error).toBe("ENOENT: no such file or directory");
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

  describe("result.details override (PII protection)", () => {
    it("uses result.details as audit detail when plugin sets it (suppresses params)", async () => {
      const res = await POST(
        makeRequest({
          phase: "end",
          toolName: "pinchy_write",
          agentId: "agent-1",
          sessionKey: "agent:agent-1:direct:user-1",
          params: {
            path: "/root/.openclaw/workspaces/agent-1/uploads/secret.txt",
            content: "MY PRIVATE PERSONAL CONTENT WITH SECRETS",
            overwrite: false,
          },
          result: {
            content: [{ type: "text", text: "Wrote 40 bytes" }],
            details: {
              path: "uploads/secret.txt",
              mode: "create",
              sizeBytes: 40,
              contentHash: "abc123",
              overwrite: false,
            },
          },
        })
      );

      expect(res.status).toBe(200);

      const call = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(call.detail.toolName).toBe("pinchy_write");
      // details fields merged into audit detail
      expect(call.detail.path).toBe("uploads/secret.txt");
      expect(call.detail.contentHash).toBe("abc123");
      expect(call.detail.mode).toBe("create");
      // raw params must NOT appear
      expect(call.detail).not.toHaveProperty("params");
      // raw content string must NOT appear anywhere in audit detail
      expect(JSON.stringify(call.detail)).not.toContain("PRIVATE PERSONAL");
    });

    it("keeps params in audit detail when result has no details field", async () => {
      await POST(
        makeRequest({
          phase: "end",
          toolName: "pinchy_read",
          agentId: "agent-1",
          params: { path: "/data/kb/report.md" },
          result: {
            content: [{ type: "text", text: "file contents" }],
            // no details field
          },
        })
      );

      const call = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(call.detail).toHaveProperty("params");
      expect((call.detail.params as Record<string, unknown>).path).toBe("/data/kb/report.md");
    });

    it("keeps params when result.details is not a plain object", async () => {
      await POST(
        makeRequest({
          phase: "end",
          toolName: "some_tool",
          agentId: "agent-1",
          params: { action: "run" },
          result: {
            content: [{ type: "text", text: "ok" }],
            details: "just a string",
          },
        })
      );

      const call = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(call.detail).toHaveProperty("params");
    });

    it("plugin-supplied details cannot override system fields toolName/success", async () => {
      await POST(
        makeRequest({
          phase: "end",
          toolName: "pinchy_write",
          agentId: "agent-1",
          params: { path: "/workspace/out.csv", content: "data" },
          result: {
            content: [{ type: "text", text: "ok" }],
            details: { toolName: "spoofed", success: false, path: "/workspace/out.csv" },
          },
        })
      );

      const call = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(call.detail.toolName).toBe("pinchy_write");
      expect(call.detail.success).toBe(true);
    });
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

    it("does not include result payload in audit log", async () => {
      await POST(
        makeRequest({
          phase: "end",
          toolName: "odoo_read",
          agentId: "agent-1",
          result: { records: [{ name: "Customer A", amount: 50000 }] },
        })
      );

      const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
      const detail = call?.detail as Record<string, unknown>;
      expect(detail).not.toHaveProperty("result");
      expect(detail?.success).toBe(true);
    });

    it("logs error message but not result on failure", async () => {
      await POST(
        makeRequest({
          phase: "end",
          toolName: "odoo_read",
          agentId: "agent-1",
          error: "AccessError: permission denied",
        })
      );

      const call = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
      const detail = call?.detail as Record<string, unknown>;
      expect(detail?.success).toBe(false);
      expect(detail?.error).toBe("AccessError: permission denied");
      expect(detail).not.toHaveProperty("result");
    });
  });
});

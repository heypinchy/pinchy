import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOn = vi.fn();

function createMockApi(config: { apiBaseUrl: string; gatewayToken: string } | undefined) {
  return {
    id: "pinchy-audit",
    name: "Pinchy Audit",
    source: "test",
    config: {},
    pluginConfig: config,
    runtime: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: mockOn,
  };
}

describe("pinchy-audit plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("registers before_tool_call and after_tool_call hooks", async () => {
    const { default: plugin } = await import("./index");
    plugin.register?.(
      createMockApi({
        apiBaseUrl: "http://pinchy:7777",
        gatewayToken: "gw-token",
      }) as any
    );

    const hookNames = mockOn.mock.calls.map((c) => c[0]);
    expect(hookNames).toContain("before_tool_call");
    expect(hookNames).toContain("after_tool_call");
  });

  it("posts start events from before_tool_call", async () => {
    const { default: plugin } = await import("./index");
    plugin.register?.(
      createMockApi({
        apiBaseUrl: "http://pinchy:7777",
        gatewayToken: "gw-token",
      }) as any
    );

    const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
    expect(beforeHook).toBeDefined();

    await beforeHook(
      {
        toolName: "pinchy_read",
        params: { path: "/data/policy.md" },
        runId: "run-1",
        toolCallId: "tool-1",
      },
      {
        agentId: "agent-1",
        sessionKey: "agent:agent-1:user-user-1",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "pinchy_read",
        toolCallId: "tool-1",
      }
    );

    expect(fetch).toHaveBeenCalledWith("http://pinchy:7777/api/internal/audit/tool-use", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer gw-token",
      },
      body: JSON.stringify({
        phase: "start",
        toolName: "pinchy_read",
        params: { path: "/data/policy.md" },
        runId: "run-1",
        toolCallId: "tool-1",
        agentId: "agent-1",
        sessionKey: "agent:agent-1:user-user-1",
        sessionId: "session-1",
      }),
    });
  });

  it("posts end events from after_tool_call and includes errors", async () => {
    const { default: plugin } = await import("./index");
    plugin.register?.(
      createMockApi({
        apiBaseUrl: "http://pinchy:7777",
        gatewayToken: "gw-token",
      }) as any
    );

    const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];
    expect(afterHook).toBeDefined();

    await afterHook(
      {
        toolName: "browser",
        params: { url: "https://example.com" },
        runId: "run-2",
        toolCallId: "tool-2",
        error: "Request failed",
        durationMs: 123,
      },
      {
        agentId: "agent-2",
        sessionKey: "agent:agent-2:user-user-1",
        sessionId: "session-2",
        runId: "run-2",
        toolName: "browser",
        toolCallId: "tool-2",
      }
    );

    expect(fetch).toHaveBeenCalledWith("http://pinchy:7777/api/internal/audit/tool-use", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer gw-token",
      },
      body: JSON.stringify({
        phase: "end",
        toolName: "browser",
        params: { url: "https://example.com" },
        runId: "run-2",
        toolCallId: "tool-2",
        agentId: "agent-2",
        sessionKey: "agent:agent-2:user-user-1",
        sessionId: "session-2",
        result: undefined,
        error: "Request failed",
        durationMs: 123,
      }),
    });
  });

  it("derives agentId from sessionKey when context has no agentId", async () => {
    const { default: plugin } = await import("./index");
    plugin.register?.(
      createMockApi({
        apiBaseUrl: "http://pinchy:7777",
        gatewayToken: "gw-token",
      }) as any
    );

    const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];
    expect(afterHook).toBeDefined();

    await afterHook(
      {
        toolName: "pinchy_read",
        params: { path: "/data/policy.md" },
      },
      {
        sessionKey: "agent:derived-agent-id:main",
        toolName: "pinchy_read",
      }
    );

    expect(fetch).toHaveBeenCalledWith("http://pinchy:7777/api/internal/audit/tool-use", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer gw-token",
      },
      body: JSON.stringify({
        phase: "end",
        toolName: "pinchy_read",
        params: { path: "/data/policy.md" },
        runId: undefined,
        toolCallId: undefined,
        agentId: "derived-agent-id",
        sessionKey: "agent:derived-agent-id:main",
        sessionId: undefined,
        result: undefined,
        error: undefined,
        durationMs: undefined,
      }),
    });
  });

  it("reuses recent start context when after_tool_call lacks context identifiers", async () => {
    const { default: plugin } = await import("./index");
    plugin.register?.(
      createMockApi({
        apiBaseUrl: "http://pinchy:7777",
        gatewayToken: "gw-token",
      }) as any
    );

    const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
    const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];
    expect(beforeHook).toBeDefined();
    expect(afterHook).toBeDefined();

    await beforeHook(
      {
        toolName: "pinchy_read",
        params: { path: "/data/policy.md" },
      },
      {
        agentId: "agent-from-start",
        sessionKey: "agent:agent-from-start:main",
        sessionId: "session-from-start",
        runId: "run-from-start",
        toolName: "pinchy_read",
      }
    );

    await afterHook(
      {
        toolName: "pinchy_read",
        params: { path: "/data/policy.md" },
      },
      {
        toolName: "pinchy_read",
      }
    );

    expect(fetch).toHaveBeenLastCalledWith("http://pinchy:7777/api/internal/audit/tool-use", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer gw-token",
      },
      body: JSON.stringify({
        phase: "end",
        toolName: "pinchy_read",
        params: { path: "/data/policy.md" },
        runId: "run-from-start",
        toolCallId: undefined,
        agentId: "agent-from-start",
        sessionKey: "agent:agent-from-start:main",
        sessionId: "session-from-start",
        result: undefined,
        error: undefined,
        durationMs: undefined,
      }),
    });
  });

  describe("sensitive data sanitization", () => {
    it("redacts sensitive key names in params before posting", async () => {
      const { default: plugin } = await import("./index");
      plugin.register?.(
        createMockApi({
          apiBaseUrl: "http://pinchy:7777",
          gatewayToken: "gw-token",
        }) as any
      );

      const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];

      await afterHook(
        {
          toolName: "http_request",
          params: { url: "https://api.example.com", apiKey: "sk-live-secret123" },
          result: "ok",
          durationMs: 50,
        },
        {
          agentId: "agent-1",
          sessionKey: "agent:agent-1:user-user-1",
          toolName: "http_request",
        }
      );

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.params.apiKey).toBe("[REDACTED]");
      expect(body.params.url).toBe("https://api.example.com");
    });

    it("redacts secret patterns in result strings before posting", async () => {
      const { default: plugin } = await import("./index");
      plugin.register?.(
        createMockApi({
          apiBaseUrl: "http://pinchy:7777",
          gatewayToken: "gw-token",
        }) as any
      );

      const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];

      await afterHook(
        {
          toolName: "pinchy_read",
          params: { path: "/data/.env" },
          result: "API_KEY=sk-abcdefghijklmnopqrstuvwxyz\nAPP_NAME=pinchy",
          durationMs: 10,
        },
        {
          agentId: "agent-1",
          sessionKey: "agent:agent-1:user-user-1",
          toolName: "pinchy_read",
        }
      );

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(body.result).toContain("[REDACTED]");
    });

    it("also sanitizes params in before_tool_call events", async () => {
      const { default: plugin } = await import("./index");
      plugin.register?.(
        createMockApi({
          apiBaseUrl: "http://pinchy:7777",
          gatewayToken: "gw-token",
        }) as any
      );

      const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];

      await beforeHook(
        {
          toolName: "http_request",
          params: { password: "super-secret" },
        },
        {
          agentId: "agent-1",
          sessionKey: "agent:agent-1:user-user-1",
          toolName: "http_request",
        }
      );

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.params.password).toBe("[REDACTED]");
    });
  });

  it("does not throw when audit endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { default: plugin } = await import("./index");
    plugin.register?.(
      createMockApi({
        apiBaseUrl: "http://pinchy:7777",
        gatewayToken: "gw-token",
      }) as any
    );

    const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
    await expect(
      beforeHook(
        { toolName: "pinchy_read", params: {}, runId: "run-1", toolCallId: "tool-1" },
        { toolName: "pinchy_read" }
      )
    ).resolves.toBeUndefined();
  });
});

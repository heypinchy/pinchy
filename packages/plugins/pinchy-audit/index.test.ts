// @vitest-environment node
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

  it("registers pinchy.trajectory.read for admin clients, reading under the runtime's state dir", async () => {
    const { default: plugin } = await import("./index");
    const resolveStateDir = vi.fn(() => "/nonexistent-state-dir");
    const api = {
      ...createMockApi({ apiBaseUrl: "http://pinchy:7777", gatewayToken: "gw-token" }),
      runtime: { state: { resolveStateDir } },
    };
    plugin.register?.(api as any);

    expect(api.registerGatewayMethod).toHaveBeenCalledWith(
      "pinchy.trajectory.read",
      expect.any(Function),
      { scope: "operator.admin" }
    );
    const handler = api.registerGatewayMethod.mock.calls[0][1];
    const respond = vi.fn();
    handler({ params: { agentId: "smithers", sessionKey: "agent:smithers:direct:u" }, respond });
    expect(resolveStateDir).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { sessionId: null, jsonl: null });
  });

  // Usage tracking and the diagnostics export depend on this method, not on
  // the audit forwarding, so a missing audit config must not take it down.
  it("registers pinchy.trajectory.read even when the audit config is missing", async () => {
    const { default: plugin } = await import("./index");
    const api = {
      ...createMockApi(undefined),
      runtime: { state: { resolveStateDir: () => "/nonexistent-state-dir" } },
    };
    plugin.register?.(api as any);

    expect(api.registerGatewayMethod).toHaveBeenCalledWith(
      "pinchy.trajectory.read",
      expect.any(Function),
      { scope: "operator.admin" }
    );
  });

  // Telegram linking and access go through these since OpenClaw 2026.9 keeps
  // pairing state in its own database; like the trajectory read, they must
  // not depend on the audit config.
  it("registers the pairing store methods for admin clients, even without audit config", async () => {
    const { default: plugin } = await import("./index");
    const resolveStateDir = vi.fn(() => "/nonexistent-state-dir");
    const api = { ...createMockApi(undefined), runtime: { state: { resolveStateDir } } };
    plugin.register?.(api as any);

    for (const method of [
      "pinchy.pairing.findByCode",
      "pinchy.pairing.removeRequests",
      "pinchy.pairing.setAllowFrom",
    ]) {
      expect(api.registerGatewayMethod).toHaveBeenCalledWith(method, expect.any(Function), {
        scope: "operator.admin",
      });
    }
    const findByCode = api.registerGatewayMethod.mock.calls.find(
      (c) => c[0] === "pinchy.pairing.findByCode"
    )![1];
    const respond = vi.fn();
    findByCode({ params: { channel: "telegram", code: "ABCD1234" }, respond });
    expect(resolveStateDir).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { request: null });
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
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
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
        // The after event carries the same runId as before (real OpenClaw
        // behavior) so the start record correlates; only the IDENTITY fields
        // (agentId/sessionKey/sessionId) are missing and recovered from the map.
        runId: "run-from-start",
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
      signal: expect.any(AbortSignal),
    });
  });

  it("attributes each concurrent same-name tool call to its OWN agent", async () => {
    const { default: plugin } = await import("./index");
    plugin.register?.(
      createMockApi({ apiBaseUrl: "http://pinchy:7777", gatewayToken: "gw-token" }) as any
    );

    const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
    const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];

    // Two different agents start the SAME tool, interleaved (the plugin instance
    // is shared across agents). The second start must NOT clobber the first.
    await beforeHook(
      { toolName: "pinchy_read", toolCallId: "tc-A", params: {} },
      {
        agentId: "agent-A",
        sessionKey: "agent:agent-A:main",
        sessionId: "sess-A",
        runId: "run-A",
        toolName: "pinchy_read",
      }
    );
    await beforeHook(
      { toolName: "pinchy_read", toolCallId: "tc-B", params: {} },
      {
        agentId: "agent-B",
        sessionKey: "agent:agent-B:main",
        sessionId: "sess-B",
        runId: "run-B",
        toolName: "pinchy_read",
      }
    );

    // Agent A's call ends, carrying only its toolCallId (identity fields absent).
    await afterHook(
      { toolName: "pinchy_read", toolCallId: "tc-A", params: {} },
      { toolName: "pinchy_read" }
    );

    // The end row must be attributed to agent A — not the most-recent start (B).
    const lastBody = JSON.parse(vi.mocked(fetch).mock.lastCall![1]!.body as string);
    expect(lastBody.phase).toBe("end");
    expect(lastBody.toolCallId).toBe("tc-A");
    expect(lastBody.agentId).toBe("agent-A");
    expect(lastBody.sessionKey).toBe("agent:agent-A:main");
  });

  describe("sensitive data sanitization", () => {
    it("keeps numeric token counts readable while redacting real auth tokens (SYNC with web)", async () => {
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
          toolName: "usage_probe",
          params: { inputTokens: 240171, totalTokens: 35542, token: "tok-secret" },
          result: "ok",
          durationMs: 5,
        },
        {
          agentId: "agent-1",
          sessionKey: "agent:agent-1:user-user-1",
          toolName: "usage_probe",
        }
      );

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.params.inputTokens).toBe(240171);
      expect(body.params.totalTokens).toBe(35542);
      expect(body.params.token).toBe("[REDACTED]");
    });

    it("serializes Date values to ISO strings instead of destroying them (SYNC with web)", async () => {
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
          toolName: "calendar_read",
          params: { at: new Date("2026-06-09T16:48:57.441Z") },
          result: "ok",
          durationMs: 5,
        },
        {
          agentId: "agent-1",
          sessionKey: "agent:agent-1:user-user-1",
          toolName: "calendar_read",
        }
      );

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.params.at).toBe("2026-06-09T16:48:57.441Z");
    });

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

    it("truncates values beyond max depth instead of leaking them unredacted (SYNC with web)", async () => {
      const { default: plugin } = await import("./index");
      plugin.register?.(
        createMockApi({
          apiBaseUrl: "http://pinchy:7777",
          gatewayToken: "gw-token",
        }) as any
      );

      const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];

      // Build a 12-level deep object: depth 0 is outermost, secret lives at depth 12.
      // The depth cap is a cycle/stack-depth guard, not a redaction bypass — a
      // real Odoo command tuple nests to depth ~6, well within reach of a
      // secret this cap must not pass through verbatim.
      let nested: any = { password: "deep-secret" };
      for (let i = 0; i < 12; i++) {
        nested = { nested };
      }

      await afterHook(
        {
          toolName: "odoo_write",
          params: nested,
          result: "ok",
          durationMs: 5,
        },
        {
          agentId: "agent-1",
          sessionKey: "agent:agent-1:user-user-1",
          toolName: "odoo_write",
        }
      );

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(JSON.stringify(body.params)).not.toContain("deep-secret");
      // The MAX_DEPTH (10) check fires 10 hops in, at the object whose own
      // subtree still holds the secret two levels further down.
      let level = body.params;
      for (let i = 0; i < 10; i++) {
        level = level.nested;
      }
      expect(level).toBe("[TRUNCATED]");
    });

    it("truncates only the containers it could not inspect, keeping leaves at the cap (SYNC with web)", async () => {
      const { default: plugin } = await import("./index");
      plugin.register?.(
        createMockApi({
          apiBaseUrl: "http://pinchy:7777",
          gatewayToken: "gw-token",
        }) as any
      );

      const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];

      // A container past the cap is replaced because we never get to look
      // inside it. A leaf has no inside: its key was checked by the object one
      // level up, and pattern redaction is depth-independent — so it is exactly
      // as sanitized at depth 10 as at depth 1, and keeping it is what leaves a
      // diagnostics bundle's deepest tool arguments readable.
      let nested: any = {
        opcode: 6,
        password: "boundary-secret",
        note: "the model echoed sk-abcdefghijklmnopqrstuvwx back",
        child: { deep: "unreachable" },
      };
      // 9 wrappers put this object at depth 9, so its own values land on the
      // depth-10 boundary the cap governs.
      for (let i = 0; i < 9; i++) {
        nested = { nested };
      }

      await afterHook(
        {
          toolName: "odoo_write",
          params: nested,
          result: "ok",
          durationMs: 5,
        },
        {
          agentId: "agent-1",
          sessionKey: "agent:agent-1:user-user-1",
          toolName: "odoo_write",
        }
      );

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      let level = body.params;
      for (let i = 0; i < 9; i++) {
        level = level.nested;
      }
      expect(level.opcode).toBe(6);
      expect(level.password).toBe("[REDACTED]");
      expect(level.note).toBe("the model echoed [REDACTED] back");
      expect(level.child).toBe("[TRUNCATED]");
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

  describe("audit failure handling", () => {
    it("retries on transient failure and succeeds on subsequent attempt", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

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

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries on non-ok HTTP response", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const { default: plugin } = await import("./index");
      plugin.register?.(
        createMockApi({
          apiBaseUrl: "http://pinchy:7777",
          gatewayToken: "gw-token",
        }) as any
      );

      const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];
      await expect(
        afterHook(
          { toolName: "pinchy_read", params: {}, result: "ok" },
          { toolName: "pinchy_read", agentId: "agent-1" }
        )
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws after all retries are exhausted (fail-closed)", async () => {
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
      ).rejects.toThrow("network down");
    });

    it("throws after all retries exhausted on non-ok HTTP responses", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      const { default: plugin } = await import("./index");
      plugin.register?.(
        createMockApi({
          apiBaseUrl: "http://pinchy:7777",
          gatewayToken: "gw-token",
        }) as any
      );

      const afterHook = mockOn.mock.calls.find((c) => c[0] === "after_tool_call")?.[1];
      await expect(
        afterHook(
          { toolName: "pinchy_read", params: {}, result: "ok" },
          { toolName: "pinchy_read", agentId: "agent-1" }
        )
      ).rejects.toThrow(/audit endpoint returned 500/);
    });

    it("aborts a hung audit POST via AbortSignal.timeout(10_000) instead of blocking every tool call forever", async () => {
      // A server that never responds and never resets the connection — the
      // "hung endpoint" / "network blackhole" case the fetch timeout exists
      // to bound. The mock fetch only ever settles via the AbortSignal the
      // plugin passes in, exactly like real `fetch` does. AbortSignal.timeout
      // itself is intercepted so the test proves the SAME behavior a real
      // 10-second hang would produce, without the test taking 10+ seconds:
      // it still asserts the plugin requests a 10_000ms bound and reacts
      // correctly when that signal fires.
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
          1
        );
        return controller.signal;
      });

      const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(signal.reason ?? new Error("The operation was aborted"));
          });
        });
      });
      vi.stubGlobal("fetch", fetchMock);

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
      ).rejects.toThrow();

      // MAX_RETRIES = 2, so 3 total attempts, each racing its own timeout —
      // never a single hang that blocks forever. Only a 401 earns the longer
      // retry run: a hang already costs 10s per attempt.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
      timeoutSpy.mockRestore();
    });

    it("does not retry a definitive 4xx response and quotes the response body in the thrown error", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: "unknown toolName" })),
      });
      vi.stubGlobal("fetch", fetchMock);

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
      ).rejects.toThrow(/400.*unknown toolName/);

      // A definitive 4xx is our own bug and retrying it never helps — one
      // attempt only.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      [429, "Too Many Requests"],
      [408, "Request Timeout"],
    ])(
      "retries a %i despite it being a 4xx, because the status means 'try again'",
      async (status) => {
        // The 4xx shortcut above must not swallow the two statuses that ask for
        // a retry by definition. Getting this wrong is worse here than in
        // pinchy-transcript, which drops the message: this hook fails CLOSED, so
        // classifying a load-shedding 429 as "our own bug" would abort the tool
        // call of every agent for as long as the shedding lasts.
        vi.useFakeTimers();
        try {
          const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status })
            .mockResolvedValueOnce({ ok: true });
          vi.stubGlobal("fetch", fetchMock);

          const { default: plugin } = await import("./index");
          plugin.register?.(
            createMockApi({
              apiBaseUrl: "http://pinchy:7777",
              gatewayToken: "gw-token",
            }) as any
          );

          const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
          const resultPromise = beforeHook(
            { toolName: "pinchy_read", params: {}, runId: "run-1", toolCallId: "tool-1" },
            { toolName: "pinchy_read" }
          );

          await vi.advanceTimersByTimeAsync(250);
          expect(fetchMock).toHaveBeenCalledTimes(2);
          await expect(resultPromise).resolves.toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it("keeps retrying through a burst of 401s (config-apply window) with growing backoff, then succeeds", async () => {
      // Right after a config apply Pinchy could not read the shared gateway
      // token for a moment and answered every internal call 401. The token is
      // one bootstrap secret shared by Pinchy and every plugin, so a 401 here
      // is that moment, not a revoked credential: treating it as definitive
      // made this fail-closed hook block the tool call on the first attempt.
      vi.useFakeTimers();
      try {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 401 })
          .mockResolvedValueOnce({ ok: false, status: 401 })
          .mockResolvedValueOnce({ ok: false, status: 401 })
          .mockResolvedValueOnce({ ok: false, status: 401 })
          .mockResolvedValueOnce({ ok: true });
        vi.stubGlobal("fetch", fetchMock);

        const { default: plugin } = await import("./index");
        plugin.register?.(
          createMockApi({
            apiBaseUrl: "http://pinchy:7777",
            gatewayToken: "gw-token",
          }) as any
        );

        const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
        const resultPromise = beforeHook(
          { toolName: "pinchy_read", params: {}, runId: "run-1", toolCallId: "tool-1" },
          { toolName: "pinchy_read" }
        );

        // Exponential backoff — 250, 500, 1000, 2000 ms — so the attempts
        // spread across several seconds instead of landing in one window.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(999);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchMock).toHaveBeenCalledTimes(5);

        await expect(resultPromise).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("still fails closed when the 401s outlast every retry", async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: () => Promise.resolve(JSON.stringify({ error: "Unauthorized" })),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { default: plugin } = await import("./index");
        plugin.register?.(
          createMockApi({
            apiBaseUrl: "http://pinchy:7777",
            gatewayToken: "gw-token",
          }) as any
        );

        const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
        const resultPromise = beforeHook(
          { toolName: "pinchy_read", params: {}, runId: "run-1", toolCallId: "tool-1" },
          { toolName: "pinchy_read" }
        );
        const settled = expect(resultPromise).rejects.toThrow(/401/);
        await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000);
        await settled;
        expect(fetchMock).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries a 5xx response with backoff between attempts, then succeeds", async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 503 })
          .mockResolvedValueOnce({ ok: false, status: 503 })
          .mockResolvedValueOnce({ ok: true });
        vi.stubGlobal("fetch", fetchMock);

        const { default: plugin } = await import("./index");
        plugin.register?.(
          createMockApi({
            apiBaseUrl: "http://pinchy:7777",
            gatewayToken: "gw-token",
          }) as any
        );

        const beforeHook = mockOn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
        const resultPromise = beforeHook(
          { toolName: "pinchy_read", params: {}, runId: "run-1", toolCallId: "tool-1" },
          { toolName: "pinchy_read" }
        );

        // First retry waits 250ms, second waits 500ms (exponential) before succeeding.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        await expect(resultPromise).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

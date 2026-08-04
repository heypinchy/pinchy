// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRegisterTool = vi.fn();

function createMockApi(config: {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, { tools: string[]; userId: string }>;
}) {
  return {
    id: "pinchy-context",
    name: "Pinchy Context",
    source: "test",
    config: {},
    pluginConfig: config,
    runtime: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: mockRegisterTool,
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
    on: vi.fn(),
  };
}

const defaultConfig = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token-abc",
  agents: {
    "agent-1": { tools: ["save_user_context"], userId: "user-1" },
    "agent-2": {
      tools: ["save_user_context", "save_org_context"],
      userId: "admin-1",
    },
  },
};

describe("pinchy-context plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers save_user_context and save_org_context as tool factories", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it("save_user_context factory returns tool for configured agent", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];
    expect(factory).toBeDefined();

    const tool = factory({ agentId: "agent-1" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("pinchy_save_user_context");
  });

  it("save_user_context factory returns null for unconfigured agent", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];

    const tool = factory({ agentId: "unknown-agent" });
    expect(tool).toBeNull();
  });

  it("save_org_context factory returns tool only when agent has that tool", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_org_context"
    )?.[0];
    expect(factory).toBeDefined();

    // agent-2 has save_org_context
    const tool = factory({ agentId: "agent-2" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("pinchy_save_org_context");

    // agent-1 does NOT have save_org_context
    const tool2 = factory({ agentId: "agent-1" });
    expect(tool2).toBeNull();
  });

  it("save_user_context marks HTTP errors with isError=true (MCP convention)", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
      );

    const result = await tool.execute("call-1", { content: "..." });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to save");
  });

  it("save_user_context quotes the validation detail so the model can act on it", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });

    // Pinchy's 400 for an over-long context: `error` is the generic
    // "Validation failed", the reason the model needs is in details.fieldErrors.
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Validation failed",
          details: {
            formErrors: [],
            fieldErrors: {
              content: ["Context is too long — the limit is 16,000 characters."],
            },
          },
        }),
        { status: 400 }
      )
    );

    const result = await tool.execute("call-1", { content: "..." });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("the limit is 16,000 characters");
  });

  it("save_user_context marks thrown errors with isError=true", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });

    global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network down"));

    const result = await tool.execute("call-1", { content: "..." });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Network down");
  });

  it("aborts a hung save_user_context POST via AbortSignal.timeout(10_000) instead of blocking forever", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });

    // Simulates a Pinchy container that never answers (mid-deploy, network
    // blackhole) — the mock only ever settles via the AbortSignal the tool
    // passes to fetch, exactly like a real hung `fetch` would once the
    // signal fires.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
        1
      );
      return controller.signal;
    });
    global.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new Error("The operation was aborted"));
        });
      });
    });

    const result = await tool.execute("call-1", { content: "..." });
    expect(result.isError).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    timeoutSpy.mockRestore();
  });

  it("save_org_context marks HTTP errors with isError=true", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_org_context"
    )?.[0];
    const tool = factory({ agentId: "agent-2" });

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }));

    const result = await tool.execute("call-1", { content: "..." });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to save");
  });

  it("save_org_context marks thrown errors with isError=true", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_org_context"
    )?.[0];
    const tool = factory({ agentId: "agent-2" });

    global.fetch = vi.fn().mockRejectedValueOnce(new Error("Timeout"));

    const result = await tool.execute("call-1", { content: "..." });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Timeout");
  });

  it("save_user_context error path sets details.error (#404 audit contract)", async () => {
    // OpenClaw strips the MCP `isError` flag before forwarding the tool
    // result to /api/internal/audit/tool-use; details.error is the audit
    // route's only remaining failure signal. Without it a failed
    // pinchy_save_user_context call is silently audited as outcome: success.
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });

    global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network down"));

    const result = await tool.execute("call-1", { content: "..." });
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ error: "Network down" });
  });

  it("save_org_context error path sets details.error (#404 audit contract)", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_org_context"
    )?.[0];
    const tool = factory({ agentId: "agent-2" });

    global.fetch = vi.fn().mockRejectedValueOnce(new Error("Timeout"));

    const result = await tool.execute("call-1", { content: "..." });
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ error: "Timeout" });
  });

  it("exports plugin definition with id and configSchema", async () => {
    const { default: plugin } = await import("./index");
    expect(plugin.id).toBe("pinchy-context");
    expect(plugin.name).toBe("Pinchy Context");
    expect(plugin.configSchema).toBeDefined();
  });
});

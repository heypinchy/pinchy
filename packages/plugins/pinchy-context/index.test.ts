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

  it("exports plugin definition with id and configSchema", async () => {
    const { default: plugin } = await import("./index");
    expect(plugin.id).toBe("pinchy-context");
    expect(plugin.name).toBe("Pinchy Context");
    expect(plugin.configSchema).toBeDefined();
  });
});

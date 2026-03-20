import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync as realReadFileSync } from "fs";
import { join } from "path";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

// Mock validate module so integration tests can use real fixture paths
// (which are not under /data/). The mock validateAccess simply returns the path.
vi.mock("./validate", async (importOriginal) => {
  const original = await importOriginal<typeof import("./validate")>();
  return {
    ...original,
    validateAccess: vi.fn((_config: unknown, requestedPath: string) => requestedPath),
  };
});

const mockRegisterTool = vi.fn();

interface MockApiOptions {
  agentConfigs: Record<string, { allowed_paths: string[] }>;
  describeImageFile?: (opts: {
    filePath: string;
    cfg: unknown;
    agentDir: string;
  }) => Promise<{ text: string }>;
}

function createMockApi(agentConfigsOrOpts: Record<string, { allowed_paths: string[] }> | MockApiOptions) {
  const opts: MockApiOptions = "agentConfigs" in agentConfigsOrOpts
    ? agentConfigsOrOpts as MockApiOptions
    : { agentConfigs: agentConfigsOrOpts as Record<string, { allowed_paths: string[] }> };

  return {
    id: "pinchy-files",
    name: "Pinchy Files",
    source: "test",
    config: {},
    pluginConfig: { agents: opts.agentConfigs },
    runtime: opts.describeImageFile
      ? { mediaUnderstanding: { describeImageFile: opts.describeImageFile } }
      : {},
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

function registerAndGetReadTool(api: ReturnType<typeof createMockApi>, agentId: string) {
  // We use a fresh dynamic import each time but the module is cached,
  // so register() can be called multiple times safely.
  const plugin = require("./index").default;
  plugin.register(api as any);
  const readFactory = mockRegisterTool.mock.calls.find(
    (call: any[]) => call[1]?.name === "pinchy_read"
  )?.[0];
  return readFactory({ agentId });
}

describe("pinchy-files plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers pinchy_ls and pinchy_read as tool factories", async () => {
    const api = createMockApi({ "test-agent": { allowed_paths: ["/data/test-docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it("registers tool factories (functions), not static tools", async () => {
    const api = createMockApi({ "test-agent": { allowed_paths: ["/data/test-docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    // Both calls should pass a factory function as first arg
    for (const call of mockRegisterTool.mock.calls) {
      expect(typeof call[0]).toBe("function");
    }
  });

  it("pinchy_ls factory returns tool for configured agents", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/data/docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const lsFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_ls"
    )?.[0];
    expect(lsFactory).toBeDefined();

    const tool = lsFactory({ agentId: "agent-1" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("pinchy_ls");
    expect(tool.label).toBe("List Files");
    expect(tool.description).toContain("/data/docs/");
  });

  it("pinchy_ls factory returns null for unconfigured agents", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/data/docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const lsFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_ls"
    )?.[0];

    const tool = lsFactory({ agentId: "unknown-agent" });
    expect(tool).toBeNull();
  });

  it("pinchy_read factory returns tool for configured agents", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/data/docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const readFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_read"
    )?.[0];
    expect(readFactory).toBeDefined();

    const tool = readFactory({ agentId: "agent-1" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("pinchy_read");
    expect(tool.label).toBe("Read File");
    expect(tool.description).toContain("/data/docs/");
  });

  it("pinchy_read factory returns null for unconfigured agents", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/data/docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const readFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_read"
    )?.[0];

    const tool = readFactory({ agentId: "other-agent" });
    expect(tool).toBeNull();
  });

  it("exports a plugin definition with id and configSchema", async () => {
    const { default: plugin } = await import("./index");
    expect(plugin.id).toBe("pinchy-files");
    expect(plugin.name).toBe("Pinchy Files");
    expect(plugin.configSchema).toBeDefined();
  });

  it("pinchy_ls path parameter description includes the allowed paths", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/data/docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const lsFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_ls"
    )?.[0];
    const tool = lsFactory({ agentId: "agent-1" });

    const pathParamDescription = tool.parameters.properties.path.description;
    expect(pathParamDescription).toContain("/data/docs/");
  });

  it("pinchy_ls description instructs model to use it first", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/data/docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const lsFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_ls"
    )?.[0];
    const tool = lsFactory({ agentId: "agent-1" });

    expect(tool.description.toLowerCase()).toMatch(/first|start/);
  });

  it("pinchy_read path parameter description includes the allowed paths", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/data/docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const readFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_read"
    )?.[0];
    const tool = readFactory({ agentId: "agent-1" });

    const pathParamDescription = tool.parameters.properties.path.description;
    expect(pathParamDescription).toContain("/data/docs/");
  });

  it("pinchy_read description tells model to use pinchy_ls first", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/data/docs/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const readFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_read"
    )?.[0];
    const tool = readFactory({ agentId: "agent-1" });

    expect(tool.description).toContain("pinchy_ls");
  });
});

describe("pinchy_read PDF integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getReadTool(api: ReturnType<typeof createMockApi>) {
    const { default: plugin } = await import("./index");
    plugin.register(api as any);
    const readFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_read"
    )?.[0];
    return readFactory({ agentId: "agent-1" });
  }

  it("returns XML-wrapped content for PDF files", async () => {
    const fixturePath = join(FIXTURES, "text-only.pdf");
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: fixturePath });

    expect(result.content[0].text).toContain("<document>");
    expect(result.content[0].text).toContain("</document>");
    expect(result.content[0].text).toContain("<document_content>");
  });

  it("returns plain text for non-PDF files", async () => {
    const fixturePath = join(FIXTURES, "text-only.expected.txt");
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: fixturePath });

    // Should NOT contain XML wrapper — plain text
    expect(result.content[0].text).not.toContain("<document>");
    // Should contain the file content directly
    const expectedContent = realReadFileSync(fixturePath, "utf-8");
    expect(result.content[0].text).toBe(expectedContent);
  });

  it("captures describeImage from api.runtime.mediaUnderstanding", async () => {
    const mockDescribe = vi.fn().mockResolvedValue({ text: "A scanned document" });
    const fixturePath = join(FIXTURES, "scanned.pdf");

    const api = createMockApi({
      agentConfigs: { "agent-1": { allowed_paths: [FIXTURES + "/"] } },
      describeImageFile: mockDescribe,
    });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: fixturePath });

    // describeImage should have been called for scanned pages
    expect(mockDescribe).toHaveBeenCalled();
    expect(result.content[0].text).toContain("<document>");
  });

  it("returns a clear error message for password-protected PDFs", async () => {
    const fixturePath = join(FIXTURES, "password-protected.pdf");
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: fixturePath });

    // Should return an error message, not crash
    expect(result.content[0].text.toLowerCase()).toMatch(/password|protected|encrypted/);
  });

  it("returns a clear error message for corrupted PDFs", async () => {
    const fixturePath = join(FIXTURES, "corrupted.pdf");
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: fixturePath });

    // Should return an error message, not crash
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // Should not contain XML wrapper (it's an error)
    expect(result.content[0].text).not.toContain("<document>");
  });

  it("uses cache for repeated PDF reads", async () => {
    const fixturePath = join(FIXTURES, "text-only.pdf");
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    // First read
    const result1 = await tool.execute("call-1", { path: fixturePath });
    // Second read (should use cache)
    const result2 = await tool.execute("call-2", { path: fixturePath });

    expect(result1.content[0].text).toBe(result2.content[0].text);
    expect(result1.content[0].text).toContain("<document>");
  });
});

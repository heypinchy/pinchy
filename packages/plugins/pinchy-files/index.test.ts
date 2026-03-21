import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readFileSync as realReadFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

// Set cache dir to a temp directory before any imports of index.ts
const testCacheDir = mkdtempSync(join(tmpdir(), "pinchy-files-test-cache-"));
process.env.PINCHY_PDF_CACHE_DIR = testCacheDir;

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

function createMockApi(agentConfigs: Record<string, { allowed_paths: string[] }>) {
  return {
    id: "pinchy-files",
    name: "Pinchy Files",
    source: "test",
    config: {},
    pluginConfig: { agents: agentConfigs },
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

  it("pinchy_ls filters out Office lock files (~$document.docx)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pinchy-lockfiles-test-"));
    try {
      writeFileSync(join(tmpDir, "document.docx"), "real doc");
      writeFileSync(join(tmpDir, "~$document.docx"), "lock file");
      writeFileSync(join(tmpDir, "~$budget.xlsx"), "lock file");

      const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
      const { default: plugin } = await import("./index");
      plugin.register!(api as any);

      const lsFactory = mockRegisterTool.mock.calls.find(
        (call: any[]) => call[1]?.name === "pinchy_ls"
      )?.[0];
      const tool = lsFactory({ agentId: "agent-1" });

      const result = await tool.execute("call-1", { path: tmpDir });
      const entries = JSON.parse(result.content[0].text);
      const names = entries.map((e: { name: string }) => e.name);

      expect(names).toContain("document.docx");
      expect(names).not.toContain("~$document.docx");
      expect(names).not.toContain("~$budget.xlsx");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pinchy_ls filters out system files (Thumbs.db, desktop.ini, .DS_Store)", async () => {
    // Create a temp directory with system files and a normal file
    const tmpDir = mkdtempSync(join(tmpdir(), "pinchy-sysfiles-test-"));
    try {
      writeFileSync(join(tmpDir, "report.pdf"), "fake pdf");
      writeFileSync(join(tmpDir, "Thumbs.db"), "");
      writeFileSync(join(tmpDir, "desktop.ini"), "");
      writeFileSync(join(tmpDir, "$RECYCLE.BIN"), "");
      writeFileSync(join(tmpDir, "System Volume Information"), "");
      writeFileSync(join(tmpDir, ".DS_Store"), "");

      const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
      const { default: plugin } = await import("./index");
      plugin.register!(api as any);

      const lsFactory = mockRegisterTool.mock.calls.find(
        (call: any[]) => call[1]?.name === "pinchy_ls"
      )?.[0];
      const tool = lsFactory({ agentId: "agent-1" });

      const result = await tool.execute("call-1", { path: tmpDir });
      const entries = JSON.parse(result.content[0].text);
      const names = entries.map((e: { name: string }) => e.name);

      expect(names).toContain("report.pdf");
      expect(names).not.toContain("Thumbs.db");
      expect(names).not.toContain("desktop.ini");
      expect(names).not.toContain("$RECYCLE.BIN");
      expect(names).not.toContain("System Volume Information");
      expect(names).not.toContain(".DS_Store");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("pinchy_read PDF integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(testCacheDir, { recursive: true, force: true });
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

  it("returns text with fallback message for scanned PDFs without vision config", async () => {
    const fixturePath = join(FIXTURES, "scanned.pdf");
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: fixturePath });

    // Without vision config (no modelAuth in mock API), scanned pages show fallback
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("<document>");
    expect(result.content[0].text).toContain("Unable to extract text");
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

  it("calls vision API for scanned pages when modelAuth is available", async () => {
    // Reset the module cache so a fresh PdfCache instance is created.
    // A previous test may have cached the scanned PDF result without vision.
    vi.resetModules();
    const { rmSync: rm } = await import("fs");
    const cacheSqlite = join(testCacheDir, "pdf-cache.sqlite");
    rm(cacheSqlite, { force: true });
    rm(cacheSqlite + "-wal", { force: true });
    rm(cacheSqlite + "-shm", { force: true });

    const mockResolveApiKey = vi.fn().mockResolvedValue({ apiKey: "test-key" });
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });

    // Add runtime with modelAuth and config
    (api as any).runtime = {
      ...api.runtime,
      modelAuth: {
        resolveApiKeyForProvider: mockResolveApiKey,
      },
      config: {
        loadConfig: () => ({
          agents: {
            list: [{ id: "agent-1", model: "anthropic/claude-haiku-4-5-20251001" }],
          },
        }),
      },
    };

    // Mock fetch globally to simulate Anthropic API response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Vision extracted: HWB 234 kWh/m²a" }],
      }),
    });

    try {
      const { default: plugin } = await import("./index");
      vi.clearAllMocks(); // Clear import-related mocks but keep our fetch mock

      // Re-setup our mocks after clearAllMocks
      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Vision extracted: HWB 234 kWh/m²a" }],
        }),
      });
      mockResolveApiKey.mockResolvedValue({ apiKey: "test-key" });

      plugin.register!(api as any);

      const readFactory = mockRegisterTool.mock.calls.find(
        (call: any[]) => call[1]?.name === "pinchy_read"
      )?.[0];
      const tool = readFactory({ agentId: "agent-1" });

      const fixturePath = join(FIXTURES, "scanned.pdf");
      const result = await tool.execute("call-1", { path: fixturePath });

      // resolveApiKeyForProvider should be called with {provider, cfg} object
      expect(mockResolveApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "anthropic" })
      );

      // The result should contain the vision-extracted text, NOT the fallback
      expect(result.content[0].text).toContain("HWB 234");
      expect(result.content[0].text).not.toContain("Unable to extract text");
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it("does not cache scanned PDF results when vision was unavailable", async () => {
    // Clear cache first
    const { rmSync: rm } = await import("fs");
    const cacheSqlite = join(testCacheDir, "pdf-cache.sqlite");
    rm(cacheSqlite, { force: true });
    rm(cacheSqlite + "-wal", { force: true });
    rm(cacheSqlite + "-shm", { force: true });

    vi.resetModules();

    const fixturePath = join(FIXTURES, "scanned.pdf");

    // First read: no modelAuth → vision unavailable → fallback text
    const api1 = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const { default: plugin1 } = await import("./index");
    plugin1.register!(api1 as any);
    const readFactory1 = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_read"
    )?.[0];
    const tool1 = readFactory1({ agentId: "agent-1" });
    const result1 = await tool1.execute("call-1", { path: fixturePath });

    // Should contain fallback message (no vision)
    expect(result1.content[0].text).toContain("Unable to extract text");

    // Second read: with modelAuth → vision should be attempted, not served from cache
    vi.resetModules();
    vi.clearAllMocks();

    const mockResolveApiKey = vi.fn().mockResolvedValue({ apiKey: "test-key" });
    const api2 = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    (api2 as any).runtime = {
      ...api2.runtime,
      modelAuth: { resolveApiKeyForProvider: mockResolveApiKey },
      config: {
        loadConfig: () => ({
          agents: { list: [{ id: "agent-1", model: "anthropic/claude-haiku-4-5-20251001" }] },
        }),
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Vision extracted: HWB 234 kWh/m²a" }],
      }),
    });

    try {
      const { default: plugin2 } = await import("./index");
      plugin2.register!(api2 as any);
      const readFactory2 = mockRegisterTool.mock.calls.find(
        (call: any[]) => call[1]?.name === "pinchy_read"
      )?.[0];
      const tool2 = readFactory2({ agentId: "agent-1" });
      const result2 = await tool2.execute("call-2", { path: fixturePath });

      // Should NOT contain fallback — vision should have been called (not cached)
      expect(result2.content[0].text).toContain("HWB 234");
      expect(result2.content[0].text).not.toContain("Unable to extract text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not re-extract PDF on cache hit", async () => {
    const fixturePath = join(FIXTURES, "text-only.pdf");
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    // First read — extraction happens
    const result1 = await tool.execute("call-1", { path: fixturePath });

    // Second read — should use cache, not re-extract
    const result2 = await tool.execute("call-2", { path: fixturePath });

    // Results must be identical
    expect(result1.content[0].text).toBe(result2.content[0].text);

    // Verify cache DB has exactly one entry for this path (not two),
    // confirming the second read used cache rather than inserting a new row
    const db = new Database(join(testCacheDir, "pdf-cache.sqlite"));
    const rows = db.prepare("SELECT COUNT(*) as count FROM pdf_cache WHERE path = ?").get(fixturePath) as { count: number };
    expect(rows.count).toBe(1);
    db.close();
  });
});

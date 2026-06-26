// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { readFileSync as realReadFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { MAX_DOCX_FILE_SIZE } from "./validate";

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

function createMockApi(agentConfigs: Record<string, { allowed_paths: string[]; write_paths?: string[] }>) {
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

    expect(mockRegisterTool).toHaveBeenCalledTimes(3);
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

  it("pinchy_ls marks errors with isError=true (MCP convention)", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: ["/nonexistent-dir-xyz/"] } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const lsFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_ls"
    )?.[0];
    const tool = lsFactory({ agentId: "agent-1" });

    const result = await tool.execute("call-1", { path: "/nonexistent-dir-xyz/" });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
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

  it("marks missing-file errors with isError=true (MCP convention)", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: join(FIXTURES, "does-not-exist.md") });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/ENOENT|no such file/);
  });

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

  // Shared harness for the scanned-page vision path: fresh module/cache, a
  // mocked modelAuth + loadConfig runtime, and a globally-mocked fetch returning
  // `fetchJson`. Returns the tool result and the modelAuth spy so each test can
  // assert on the dispatched provider and/or extracted text. Restores fetch.
  async function runScannedPdfVision(opts: {
    agentModel: string;
    visionModelOverride?: string;
    fetchJson: () => Promise<unknown>;
  }): Promise<{ result: any; mockResolveApiKey: ReturnType<typeof vi.fn> }> {
    vi.resetModules();
    const { rmSync: rm } = await import("fs");
    const cacheSqlite = join(testCacheDir, "pdf-cache.sqlite");
    rm(cacheSqlite, { force: true });
    rm(cacheSqlite + "-wal", { force: true });
    rm(cacheSqlite + "-shm", { force: true });

    const mockResolveApiKey = vi.fn().mockResolvedValue({ apiKey: "test-key" });
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    if (opts.visionModelOverride) {
      (api as any).pluginConfig.visionModel = opts.visionModelOverride;
    }
    (api as any).runtime = {
      ...api.runtime,
      modelAuth: { resolveApiKeyForProvider: mockResolveApiKey },
      config: {
        loadConfig: () => ({ agents: { list: [{ id: "agent-1", model: opts.agentModel }] } }),
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: opts.fetchJson });
    try {
      const { default: plugin } = await import("./index");
      vi.clearAllMocks(); // Clear import-related mocks but keep our fetch + auth mocks
      (globalThis.fetch as any).mockResolvedValue({ ok: true, json: opts.fetchJson });
      mockResolveApiKey.mockResolvedValue({ apiKey: "test-key" });

      plugin.register!(api as any);
      const readFactory = mockRegisterTool.mock.calls.find(
        (call: any[]) => call[1]?.name === "pinchy_read"
      )?.[0];
      const tool = readFactory({ agentId: "agent-1" });
      const result = await tool.execute("call-1", { path: join(FIXTURES, "scanned.pdf") });
      return { result, mockResolveApiKey };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("calls vision API for scanned pages when modelAuth is available", async () => {
    const { result, mockResolveApiKey } = await runScannedPdfVision({
      agentModel: "anthropic/claude-haiku-4-5-20251001",
      fetchJson: async () => ({
        content: [{ type: "text", text: "Vision extracted: HWB 234 kWh/m²a" }],
      }),
    });

    // resolveApiKeyForProvider should be called with {provider, cfg} object
    expect(mockResolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic" })
    );
    // The result should contain the vision-extracted text, NOT the fallback
    expect(result.content[0].text).toContain("HWB 234");
    expect(result.content[0].text).not.toContain("Unable to extract text");
  });

  it("prefers the pluginConfig.visionModel over the agent's own chat model for vision", async () => {
    // The agent's chat model is anthropic, but Pinchy emitted a dedicated
    // visionModel pointing at google. Vision must dispatch to GOOGLE — proving
    // scanned-page description is decoupled from the (possibly text-only) chat
    // model and uses the live-resolved visionModel instead.
    const { mockResolveApiKey } = await runScannedPdfVision({
      agentModel: "anthropic/claude-haiku-4-5-20251001",
      visionModelOverride: "google/gemini-2.5-flash",
      fetchJson: async () => ({
        candidates: [{ content: { parts: [{ text: "Vision via google" }] } }],
      }),
    });

    // The override (google) wins over the agent's anthropic model.
    expect(mockResolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google" })
    );
    expect(mockResolveApiKey).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic" })
    );
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

describe("pinchy_read DOCX integration", () => {
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

  it("returns extracted text for .docx files instead of ZIP binary", async () => {
    const fixturePath = join(FIXTURES, "simple.docx");
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: fixturePath });

    expect(result.content[0].type).toBe("text");
    // The bug we are fixing: utf-8 reading a docx returns binary that
    // begins with the ZIP magic bytes "PK".
    expect(result.content[0].text.startsWith("PK")).toBe(false);

    // Every phrase from the golden file must appear in the agent-visible text.
    const expected = realReadFileSync(
      join(FIXTURES, "simple.expected.txt"),
      "utf-8",
    );
    for (const phrase of expected.split("\n").filter(Boolean)) {
      expect(result.content[0].text).toContain(phrase);
    }
  });

  it("marks missing .docx files with isError=true (MCP convention)", async () => {
    const api = createMockApi({ "agent-1": { allowed_paths: [FIXTURES + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", {
      path: join(FIXTURES, "does-not-exist.docx"),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/ENOENT|no such file/);
  });

  it("rejects .docx files larger than MAX_DOCX_FILE_SIZE with isError=true", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pinchy-files-test-"));
    const oversizedPath = join(tmpDir, "big.docx");
    // 1 byte over the DOCX limit — content doesn't need to be a valid ZIP
    // because the size gate runs before mammoth ever sees the buffer.
    writeFileSync(oversizedPath, Buffer.alloc(MAX_DOCX_FILE_SIZE + 1));

    try {
      const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
      const tool = await getReadTool(api);

      const result = await tool.execute("call-1", { path: oversizedPath });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/too large/i);
      // The cited limit must be the DOCX cap, not the generic one.
      expect(result.content[0].text).toContain(String(MAX_DOCX_FILE_SIZE));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("pinchy_read image integration", () => {
  // A user can drop an image on any agent via the chat composer; the first-pass
  // analysis works because the gateway feeds the upload to the model as native
  // multimodal input. But re-reading it later ("look at that picture again")
  // goes through pinchy_read, which used to utf-8-read the binary and hand the
  // model garbage. pinchy_read must instead return an image content block so
  // the model re-sees the picture natively, matching the first-turn behavior.
  // See issue #420.

  // 1x1 transparent PNG.
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "pinchy-image-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function getReadTool(api: ReturnType<typeof createMockApi>) {
    const { default: plugin } = await import("./index");
    plugin.register(api as any);
    const readFactory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_read"
    )?.[0];
    return readFactory({ agentId: "agent-1" });
  }

  function imageBlock(result: any) {
    return result.content.find((c: any) => c.type === "image");
  }
  function textBlock(result: any) {
    return result.content.find((c: any) => c.type === "text");
  }

  // Minimal byte sequences carrying each format's magic signature.
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const GIF_BYTES = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x01, 0x00])]);
  const WEBP_BYTES = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP"),
    Buffer.from([0x00, 0x00]),
  ]);

  it("returns an image block for image files with a known extension", async () => {
    const imgPath = join(tmpDir, "photo.png");
    writeFileSync(imgPath, Buffer.from(PNG_BASE64, "base64"));
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: imgPath });

    expect(result.isError).toBeFalsy();
    const img = imageBlock(result);
    // OpenClaw's ImageContent shape: { type: "image", data: <base64>, mimeType }.
    expect(img).toBeDefined();
    expect(img.mimeType).toBe("image/png");
    expect(img.data).toBe(PNG_BASE64);
  });

  it("detects an image by content when the file has NO extension (the reported upload(3) case)", async () => {
    // Pasted/dropped images are persisted as `upload`, `upload (1)`, … with no
    // extension (attachment-pipeline falls back to "upload"). Extension-based
    // detection misses exactly the file from the bug report; content sniffing
    // must catch it.
    const imgPath = join(tmpDir, "upload (3)");
    writeFileSync(imgPath, Buffer.from(PNG_BASE64, "base64"));
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: imgPath });

    const img = imageBlock(result);
    expect(img).toBeDefined();
    expect(img.mimeType).toBe("image/png");
    expect(img.data).toBe(PNG_BASE64);
  });

  it("maps .JPG case-insensitively and round-trips the bytes", async () => {
    const imgPath = join(tmpDir, "scan.JPG");
    writeFileSync(imgPath, JPEG_BYTES);
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: imgPath });

    const img = imageBlock(result);
    expect(img.mimeType).toBe("image/jpeg");
    expect(img.data).toBe(JPEG_BYTES.toString("base64"));
  });

  it("detects gif and webp by content even without an extension", async () => {
    const cases = [
      { name: "upload (4)", bytes: GIF_BYTES, mime: "image/gif" },
      { name: "upload (5)", bytes: WEBP_BYTES, mime: "image/webp" },
    ];
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    for (const c of cases) {
      const p = join(tmpDir, c.name);
      writeFileSync(p, c.bytes);

      const result = await tool.execute("call-1", { path: p });

      const img = imageBlock(result);
      expect(img).toBeDefined();
      expect(img.mimeType).toBe(c.mime);
      expect(img.data).toBe(c.bytes.toString("base64"));
    }
  });

  it("prefers detected content type over a misleading extension", async () => {
    // A PNG saved as `.txt` is still a PNG — return it as an image, not garbage.
    const imgPath = join(tmpDir, "note.txt");
    writeFileSync(imgPath, Buffer.from(PNG_BASE64, "base64"));
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: imgPath });

    const img = imageBlock(result);
    expect(img).toBeDefined();
    expect(img.mimeType).toBe("image/png");
  });

  it("includes a text label naming the file alongside the image", async () => {
    const imgPath = join(tmpDir, "upload (3)");
    writeFileSync(imgPath, Buffer.from(PNG_BASE64, "base64"));
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: imgPath });

    const txt = textBlock(result);
    expect(txt).toBeDefined();
    expect(txt.text).toContain("upload (3)");
  });

  it("still returns utf-8 text for a non-image file without an extension", async () => {
    const txtPath = join(tmpDir, "notes");
    writeFileSync(txtPath, "hello from a plain text file");
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: txtPath });

    expect(imageBlock(result)).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("hello from a plain text file");
  });

  // HEIC / HEIF — iPhone default format, listed in ALLOWED_ATTACHMENT_MIMES
  // (upload-validation.ts). Extension-only detection is enough here because the
  // HEIC container format has no simple 4-byte magic (it is an ISOBMFF box that
  // varies by encoder). Users can upload these files, so pinchy_read must not
  // return binary garbage for them.
  it("detects .heic by extension and returns an image block", async () => {
    const heicPath = join(tmpDir, "photo.HEIC");
    writeFileSync(heicPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])); // ftyp box prefix
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: heicPath });

    const img = imageBlock(result);
    expect(img).toBeDefined();
    expect(img.mimeType).toBe("image/heic");
  });

  it("detects .heif by extension and returns an image block", async () => {
    const heifPath = join(tmpDir, "photo.heif");
    writeFileSync(heifPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: heifPath });

    const img = imageBlock(result);
    expect(img).toBeDefined();
    expect(img.mimeType).toBe("image/heif");
  });

  it("returns isError for a non-PDF image that exceeds MAX_FILE_SIZE", async () => {
    // The fd-based size check in pinchy_read covers the non-PDF path (including
    // images). This test proves the size gate fires before the buffer is read,
    // so oversized images are rejected cleanly rather than consuming memory.
    const bigPath = join(tmpDir, "big.png");
    // Write a file larger than MAX_FILE_SIZE (10 MB) without allocating the
    // full buffer: open + truncate creates a sparse file of the desired size.
    const { open: fsOpen } = await import("fs/promises");
    const fh = await fsOpen(bigPath, "w");
    await fh.truncate(11 * 1024 * 1024 + 1); // 11 MB + 1 byte > 10 MB limit
    await fh.close();
    const api = createMockApi({ "agent-1": { allowed_paths: [tmpDir + "/"] } });
    const tool = await getReadTool(api);

    const result = await tool.execute("call-1", { path: bigPath });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/too large/i);
  });
});

describe("pinchy_write tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "pinchy-write-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getWriteFactory() {
    return mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_write"
    )?.[0];
  }

  it("does not register pinchy_write when agent has no write_paths", async () => {
    const api = createMockApi({
      "agent-1": { allowed_paths: ["/data/docs/"] },
      // no write_paths
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = getWriteFactory();
    expect(factory).toBeDefined(); // factory is registered
    const tool = factory({ agentId: "agent-1" });
    expect(tool).toBeNull(); // but returns null for this agent
  });

  it("does not register pinchy_write when write_paths is empty", async () => {
    const api = createMockApi({
      "agent-1": { allowed_paths: ["/data/docs/"], write_paths: [] },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = getWriteFactory();
    const tool = factory({ agentId: "agent-1" });
    expect(tool).toBeNull();
  });

  it("returns tool when write_paths has entries", async () => {
    const api = createMockApi({
      "agent-1": { allowed_paths: [tmpDir], write_paths: [tmpDir] },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = getWriteFactory();
    const tool = factory({ agentId: "agent-1" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("pinchy_write");
    expect(tool.label).toBe("Write File");
  });

  it("rejects a write whose ancestor symlink escapes the sandbox", async () => {
    // A pre-planted symlink whose parent dir escapes the sandbox: sandbox/link
    // -> outside. The read tools realpath before validating; the write path
    // must reject this too, or the write follows the link out of bounds.
    const sandbox = join(tmpDir, "sandbox");
    const outside = join(tmpDir, "outside");
    mkdirSync(sandbox);
    mkdirSync(outside);
    symlinkSync(outside, join(sandbox, "link"));

    const api = createMockApi({
      "agent-1": { allowed_paths: [sandbox], write_paths: [sandbox] },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const tool = getWriteFactory()({ agentId: "agent-1" });

    const result = await tool.execute("call-1", {
      path: join(sandbox, "link", "secret.txt"),
      content: "x",
    });

    expect(result.isError).toBe(true);
    // The escape must not have created the file at the real out-of-bounds path.
    expect(existsSync(join(outside, "secret.txt"))).toBe(false);
  });

  it("creates a new file with fail-on-exists default", async () => {
    const api = createMockApi({
      "agent-1": { allowed_paths: [tmpDir], write_paths: [tmpDir] },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = getWriteFactory();
    const tool = factory({ agentId: "agent-1" });

    const filePath = join(tmpDir, "report.csv");
    const result = await tool.execute("call-1", {
      path: filePath,
      content: "name,age\nAlice,30\n",
    });

    expect(result.isError).toBeFalsy();
    const written = realReadFileSync(filePath, "utf-8");
    expect(written).toBe("name,age\nAlice,30\n");
    expect(result.details).toMatchObject({
      mode: "create",
      sizeBytes: expect.any(Number),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      overwrite: false,
    });
    // content must NOT be in details (PII protection)
    expect(JSON.stringify(result.details)).not.toContain("name,age");
    // path must be relative (not start with /) — strips workspace prefix
    expect(result.details.path).not.toMatch(/^\//);
    const leaf = tmpDir.split("/").filter(Boolean).pop()!;
    expect(result.details.path).toBe(`${leaf}/report.csv`);
  });

  it("fails with isError when file exists and overwrite=false (default)", async () => {
    const filePath = join(tmpDir, "existing.csv");
    writeFileSync(filePath, "secret-csv-content-with-pii");

    const api = createMockApi({
      "agent-1": { allowed_paths: [tmpDir], write_paths: [tmpDir] },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = getWriteFactory();
    const tool = factory({ agentId: "agent-1" });

    const result = await tool.execute("call-1", {
      path: filePath,
      content: "secret-new-content-pii",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already exists/i);

    // Original file must be unchanged
    expect(realReadFileSync(filePath, "utf-8")).toBe("secret-csv-content-with-pii");

    // Failure path MUST set details so the audit endpoint suppresses raw params.
    // Without this, the audit log captures params.content verbatim (PII leak).
    expect(result.details).toBeDefined();
    expect(result.details.error).toMatch(/already exists/i);
    expect(result.details.overwrite).toBe(false);
    // content must NOT be in details
    expect(JSON.stringify(result.details)).not.toContain("secret-new-content");
  });

  it("validation error returns details (no content leak) when path is invalid", async () => {
    const api = createMockApi({
      "agent-1": { allowed_paths: [tmpDir], write_paths: [tmpDir] },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = getWriteFactory();
    const tool = factory({ agentId: "agent-1" });

    const result = await tool.execute("call-1", {
      path: 12345 as unknown as string, // not a string — triggers validation error
      content: "secret-pii-content",
    });

    expect(result.isError).toBe(true);
    // details must be present so audit endpoint suppresses params (content leak guard)
    expect(result.details).toBeDefined();
    expect(JSON.stringify(result.details)).not.toContain("secret-pii-content");
  });

  it("oversize content error returns details (no content leak)", async () => {
    const api = createMockApi({
      "agent-1": { allowed_paths: [tmpDir], write_paths: [tmpDir] },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = getWriteFactory();
    const tool = factory({ agentId: "agent-1" });

    const oversize = "x".repeat(11 * 1024 * 1024); // > MAX_FILE_SIZE (10MB)
    const result = await tool.execute("call-1", {
      path: join(tmpDir, "big.csv"),
      content: oversize,
    });

    expect(result.isError).toBe(true);
    expect(result.details).toBeDefined();
    // content must NOT be embedded in details
    expect(JSON.stringify(result.details).length).toBeLessThan(2048);
  });

  it("overwrites when overwrite=true, returns previousContentHash", async () => {
    const filePath = join(tmpDir, "overwriteme.csv");
    writeFileSync(filePath, "old content");

    const api = createMockApi({
      "agent-1": { allowed_paths: [tmpDir], write_paths: [tmpDir] },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = getWriteFactory();
    const tool = factory({ agentId: "agent-1" });

    const result = await tool.execute("call-1", {
      path: filePath,
      content: "new content",
      overwrite: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({
      mode: "overwrite",
      previousContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      overwrite: true,
    });
    // path must be relative
    expect(result.details.path).not.toMatch(/^\//);

    expect(realReadFileSync(filePath, "utf-8")).toBe("new content");
  });
});

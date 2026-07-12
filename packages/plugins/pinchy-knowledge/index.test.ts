// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatWithCitations, returnedDocumentIds, type KnowledgeSearchResult } from "./index";

const mockRegisterTool = vi.fn();

function createMockApi(config: {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, Record<string, never>>;
}) {
  return {
    id: "pinchy-knowledge",
    name: "Pinchy Knowledge",
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
    "agent-1": {},
  },
};

describe("pinchy-knowledge plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers knowledge_search as a tool factory", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    expect(mockRegisterTool).toHaveBeenCalledTimes(1);
    expect(mockRegisterTool.mock.calls[0][1]).toEqual({ name: "knowledge_search" });
  });

  it("does not register a tool when config is missing apiBaseUrl/gatewayToken", async () => {
    const api = createMockApi({ ...defaultConfig, apiBaseUrl: "" });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    expect(mockRegisterTool).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it("factory returns the tool for a configured agent", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("knowledge_search");
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["query"],
    });
  });

  it("factory returns null for an agent not granted the tool", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls[0][0];
    expect(factory({ agentId: "unknown-agent" })).toBeNull();
  });

  it("factory returns null when the context carries no agentId", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls[0][0];
    expect(factory({})).toBeNull();
  });

  it("execute posts query + agentId to the internal search route with the gateway token", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              chunkId: "c1",
              text: "Snippet one.",
              sourcePath: "/data/kb/a.pdf",
              page: 3,
              docName: "a.pdf",
            },
          ],
        }),
        { status: 200 }
      )
    );
    global.fetch = fetchMock;

    const result = await tool.execute("call-1", { query: "What is the vacation policy?" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://pinchy:7777/api/internal/knowledge/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-abc",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ query: "What is the vacation policy?", agentId: "agent-1" }),
      })
    );

    expect(result.content).toEqual([
      { type: "text", text: '[1] a.pdf (S. 3): "Snippet one."' },
    ]);
    expect(result.details).toEqual({
      toolName: "knowledge_search",
      returnedDocumentIds: [{ id: "/data/kb/a.pdf", name: "a.pdf" }],
    });
    expect(result.isError).toBeUndefined();
  });

  it("normalizes a trailing slash on apiBaseUrl", async () => {
    const api = createMockApi({ ...defaultConfig, apiBaseUrl: "http://pinchy:7777/" });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    global.fetch = fetchMock;

    await tool.execute("call-1", { query: "test" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://pinchy:7777/api/internal/knowledge/search",
      expect.anything()
    );
  });

  it("marks HTTP errors with isError=true and curated details (no raw params leak)", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Agent not found" }), { status: 404 })
      );

    const result = await tool.execute("call-1", { query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Agent not found");
    // error-only details (no toolName) — the audit endpoint suppresses raw
    // params ONLY when details carries a curated field beyond `error`, and a
    // failed call's params must survive for forensics (see the code comment
    // in index.ts referencing the 2026-06-25 false-success incident).
    expect(result.details).toEqual({ error: "Agent not found" });
  });

  it("falls back to an HTTP-status message when the error body isn't JSON", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    global.fetch = vi.fn().mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }));

    const result = await tool.execute("call-1", { query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP 502");
  });

  it("marks thrown/network errors with isError=true", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network down"));

    const result = await tool.execute("call-1", { query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network down");
  });

  it("rejects an empty/whitespace query without calling fetch", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const result = await tool.execute("call-1", { query: "   " });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exports plugin definition with id, name, and configSchema", async () => {
    const { default: plugin } = await import("./index");
    expect(plugin.id).toBe("pinchy-knowledge");
    expect(plugin.name).toBe("Pinchy Knowledge");
    expect(plugin.configSchema).toBeDefined();
  });
});

describe("formatWithCitations", () => {
  const results: KnowledgeSearchResult[] = [
    { chunkId: "c1", text: "Snippet one.", sourcePath: "/data/kb/a.pdf", page: 3, docName: "a.pdf" },
    { chunkId: "c2", text: "Snippet two.", sourcePath: "/data/kb/b.pdf", page: null, docName: "b.pdf" },
  ];

  it("formats results as numbered, citable sources with docName and page", () => {
    expect(formatWithCitations(results)).toBe(
      '[1] a.pdf (S. 3): "Snippet one."\n\n[2] b.pdf: "Snippet two."'
    );
  });

  it("returns a deterministic empty-state message for no results", () => {
    expect(formatWithCitations([])).toBe("No matching passages found in the knowledge base.");
  });
});

describe("returnedDocumentIds", () => {
  it("dedupes chunks from the same document into a single ref", () => {
    const results: KnowledgeSearchResult[] = [
      { chunkId: "c1", text: "a", sourcePath: "/data/kb/a.pdf", page: 1, docName: "a.pdf" },
      { chunkId: "c2", text: "b", sourcePath: "/data/kb/a.pdf", page: 2, docName: "a.pdf" },
      { chunkId: "c3", text: "c", sourcePath: "/data/kb/b.pdf", page: 1, docName: "b.pdf" },
    ];
    expect(returnedDocumentIds(results)).toEqual([
      { id: "/data/kb/a.pdf", name: "a.pdf" },
      { id: "/data/kb/b.pdf", name: "b.pdf" },
    ]);
  });

  it("returns an empty array for no results", () => {
    expect(returnedDocumentIds([])).toEqual([]);
  });
});

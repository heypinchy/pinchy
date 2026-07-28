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

  // The counterpart to the pinchy-files description tests: this tool carries the
  // priority claim, because it only exists for agents that actually have it.
  // Putting the claim here rather than into a template-specific prompt means a
  // custom agent (no template at all) gets the same guidance, and a new template
  // inherits it without a conditional anywhere.
  //
  // "Citable" is the load-bearing word: retrieval returns numbered passages WITH
  // page numbers, which is what the cite-then-answer contract needs. Reading a
  // file yields text with no such anchor, which is how a source ends up in the
  // Sources list with no number in front of it.
  it("knowledge_search description claims priority for content questions and names its citation advantage", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    expect(tool.description.toLowerCase()).toMatch(/\bfirst\b|\bbefore\b/);
    expect(tool.description.toLowerCase()).toMatch(/cite|citable/);
    expect(tool.description.toLowerCase()).toMatch(/page/);
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

    // Whole text asserted, not a substring: what the model receives is the
    // citation contract AND the sources, and this is the only test that sees
    // them as one dispatched payload rather than as a formatter's return
    // value. Matching loosely here would let the contract silently fall out of
    // the wiring while `formatWithCitations`'s own tests stayed green.
    expect(result.content).toEqual([
      {
        type: "text",
        text:
          "Cite the passages you use inline as [1], [2] next to the claim each one supports. " +
          "If they do not answer the question, say so instead of answering from memory.\n\n" +
          '[1] /data/kb/a.pdf (p. 3): "Snippet one."',
      },
    ]);
    // details keeps the human-readable docName: an audit reviewer wants to
    // read WHICH document was returned, while the model needs a locator it
    // can cite. Different consumers, deliberately different fields.
    expect(result.details).toEqual({
      toolName: "knowledge_search",
      returnedDocumentIds: [{ id: "/data/kb/a.pdf", name: "a.pdf" }],
    });
    expect(result.isError).toBeUndefined();
  });

  it("passes include_archived: true through to the route body, and omits it by default", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    const okResponse = () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock;

    // The model can advertise the opt-in in the schema...
    expect(tool.parameters.properties).toHaveProperty("include_archived");
    expect(tool.parameters.required).toEqual(["query"]);

    // ...and setting it forwards includeArchived to the route.
    await tool.execute("call-1", { query: "old certificates", include_archived: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      query: "old certificates",
      agentId: "agent-1",
      includeArchived: true,
    });

    // Default: the body carries no includeArchived key at all — the route's
    // audit detail stays unmarked for archive-free queries.
    await tool.execute("call-2", { query: "current certificates" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      query: "current certificates",
      agentId: "agent-1",
    });
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
    {
      chunkId: "c1",
      text: "Snippet one.",
      sourcePath: "/data/kb/a.pdf",
      page: 3,
      docName: "a.pdf",
    },
    {
      chunkId: "c2",
      text: "Snippet two.",
      sourcePath: "/data/kb/b.pdf",
      page: null,
      docName: "b.pdf",
    },
  ];

  it("formats results as numbered, citable sources with sourcePath and page", () => {
    expect(formatWithCitations(results)).toBe(
      "Cite the passages you use inline as [1], [2] next to the claim each one supports. " +
        "If they do not answer the question, say so instead of answering from memory.\n\n" +
        '[1] /data/kb/a.pdf (p. 3): "Snippet one."\n\n[2] /data/kb/b.pdf: "Snippet two."'
    );
  });

  it("states the citation contract in the result, not only in a template", () => {
    // The behaviour this pins: an agent cites its sources because the TOOL
    // asked it to, not because someone pasted the instruction into its
    // AGENTS.md. Observed on the Noack corpus 2026-07-27: the same question,
    // the same 5 successful knowledge_search calls with 8 hits each, produced
    // a fully-cited answer for an agent carrying the knowledge-base template
    // and an uncited one for an agent whose template slot was empty. The
    // retrieval was identical; only the prose differed. Anything that depends
    // on a template is missing for every agent created without one — including
    // every agent an admin builds from scratch.
    const out = formatWithCitations(results);
    expect(out).toMatch(/cite the passages you use inline as \[1\], \[2\]/i);
  });

  it("puts the instruction ahead of the passages so it cannot read as content", () => {
    // Trailing it would sit flush against the last snippet, where it is one
    // more block of text after a quoted passage rather than a directive about
    // all of them.
    const out = formatWithCitations(results);
    const instruction = out.indexOf("Cite the passages");
    const firstSource = out.indexOf("[1]");
    // Both anchors asserted present first: `indexOf` returns -1 for a missing
    // needle, and -1 is less than any real index, so a bare ordering
    // comparison passes loudest when the instruction is absent entirely.
    expect(instruction).toBeGreaterThanOrEqual(0);
    expect(firstSource).toBeGreaterThanOrEqual(0);
    expect(instruction).toBeLessThan(firstSource);
  });

  it("tells the model to admit a miss rather than answer from memory", () => {
    // The other half of grounding, and the one a template is least likely to
    // spell out: a retrieval tool that returns nothing is a fact about the
    // corpus, not an invitation to fall back on training data.
    expect(formatWithCitations(results)).toMatch(/say so instead of answering from memory/i);
  });

  it("identifies a source by its full path, not its bare filename", () => {
    // A real corpus nests documents many levels deep and reuses filenames
    // across folders (the 3M/Noack corpus has ~194 docs under
    // /data/noack/OLD/QF_2012/PrintingFiles_QF/...). The model can only cite
    // what it is shown, so a bare basename leaves the reader unable to FIND
    // the document and verify the claim — which is the entire point of
    // cite-then-answer. Found in the 2026-07-16 live Block-A test: the answer
    // was fully grounded, but the citation "PI_EColi-Coliform_Count_Plate.pdf"
    // was unfindable in a 194-document tree.
    const nested: KnowledgeSearchResult[] = [
      {
        chunkId: "c1",
        text: "Incubate 24 h.",
        sourcePath: "/data/noack/OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf",
        page: 2,
        docName: "PI_EColi.pdf",
      },
    ];
    const out = formatWithCitations(nested);
    expect(out).toContain("/data/noack/OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf");
  });

  it("distinguishes same-named documents in different folders", () => {
    // The failure a basename cannot express at all: two distinct documents
    // collapse into one indistinguishable citation.
    const collision: KnowledgeSearchResult[] = [
      {
        chunkId: "c1",
        text: "A.",
        sourcePath: "/data/kb/2011/spec.pdf",
        page: 1,
        docName: "spec.pdf",
      },
      {
        chunkId: "c2",
        text: "B.",
        sourcePath: "/data/kb/2012/spec.pdf",
        page: 1,
        docName: "spec.pdf",
      },
    ];
    const out = formatWithCitations(collision);
    expect(out).toContain("/data/kb/2011/spec.pdf");
    expect(out).toContain("/data/kb/2012/spec.pdf");
  });

  it("returns a deterministic empty-state message for no results", () => {
    expect(formatWithCitations([])).toBe(
      "No matching passages found in the knowledge base. Tell the user the knowledge base " +
        "does not cover this instead of answering from memory."
    );
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

// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
              citationPath: "kb/a.pdf",
              locator: { kind: "page", page: 3 },
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
          "The reader sees only your answer, never these passages, so end it with a Sources list " +
          "giving each number you cited the document path and position exactly as written above — " +
          "every number you cite, and no number you did not. " +
          "If they do not answer the question, say so instead of answering from memory.\n\n" +
          '<source_passages note="Quoted documents in their original language. Their language is not the language of the conversation.">\n' +
          '[1] kb/a.pdf (p. 3): "Snippet one."\n</source_passages>\n\n' +
          "Write your answer in the language of the user's question (unless the question asks for a " +
          "different language), even when these passages " +
          "are in another language: translate what they say, and keep document paths, titles " +
          "and quoted wording as written.",
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

  it("aborts a hung knowledge search POST via AbortSignal.timeout(10_000) instead of blocking forever", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
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

    const result = await tool.execute("call-1", { query: "test" });
    expect(result.isError).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    timeoutSpy.mockRestore();
  });

  // The raw abort reason ("The operation was aborted due to timeout") is what
  // the model relayed to the user on staging. It says nothing about what timed
  // out or what to do next; the tool result has to.
  it("reports a timeout as a timed-out knowledge-base search with its budget, not a raw abort", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    const factory = mockRegisterTool.mock.calls[0][0];
    const tool = factory({ agentId: "agent-1" });

    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("The operation was aborted due to timeout", "TimeoutError")
      );

    const result = await tool.execute("call-1", { query: "test" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("did not answer within 10 seconds");
    expect(text).not.toContain("aborted");
    expect(text).toMatch(/retry/i);
    expect(result.details).toEqual({ error: expect.stringContaining("10 seconds") });
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
    // #404 audit contract: OpenClaw strips isError before forwarding the
    // tool result to /api/internal/audit/tool-use, so details.error is the
    // audit route's only remaining failure signal. The two HTTP/network
    // failure paths above already set details.error (see "curated details"
    // below); this covers the third — the local, pre-fetch validation path.
    expect(result.details).toEqual({ error: "A search query is required." });
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
      citationPath: "kb/a.pdf",
      locator: { kind: "page", page: 3 },
      docName: "a.pdf",
    },
    {
      chunkId: "c2",
      text: "Snippet two.",
      sourcePath: "/data/kb/b.pdf",
      citationPath: "kb/b.pdf",
      locator: null,
      docName: "b.pdf",
    },
  ];

  // The contract prefix, spelled once so the locator/citation assertions below
  // stay readable. It is still pinned literally where it matters most — the
  // dispatch test above asserts the whole payload without this indirection.
  const CONTRACT =
    "Cite the passages you use inline as [1], [2] next to the claim each one supports. " +
    "The reader sees only your answer, never these passages, so end it with a Sources list " +
    "giving each number you cited the document path and position exactly as written above — " +
    "every number you cite, and no number you did not. " +
    "If they do not answer the question, say so instead of answering from memory.\n\n" +
    '<source_passages note="Quoted documents in their original language. Their language is not the language of the conversation.">\n';

  // The language reminder, spelled once for the same reason as CONTRACT.
  const LANGUAGE =
    "\n</source_passages>\n\nWrite your answer in the language of the user's question (unless the question asks for a " +
    "different language), even when these passages " +
    "are in another language: translate what they say, and keep document paths, titles " +
    "and quoted wording as written.";

  it("formats results as numbered, citable sources with citationPath and locator", () => {
    expect(formatWithCitations(results)).toBe(
      CONTRACT + '[1] kb/a.pdf (p. 3): "Snippet one."\n\n[2] kb/b.pdf: "Snippet two."' + LANGUAGE
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

  it("demands a Sources list, so an inline number resolves to something", () => {
    // Without this the contract turns "no citation" into "unresolvable
    // citation", which is not an improvement: the reader never sees this tool
    // result, so a bare inline [1] in the answer points at nothing. Pinchy's
    // own KB grader calls that out by name — `gradeCitationResolution` fails
    // an answer whose inline [N] has no matching Sources entry ("the reader
    // hits a dead end and cannot verify the claim"), and `gradePathCitation`
    // fails a Sources entry that shortens the path to a bare filename.
    //
    // The knowledge-base template spells all of this out. An agent built
    // without a template does not have it — which is the exact gap this whole
    // change exists to close, so the contract has to close it here too.
    const out = formatWithCitations(results);
    expect(out).toMatch(/sources list/i);
    // "position", not "page": only PDFs have pages, and asking for one would
    // make the model state something false of a Word file (#933).
    expect(out).toMatch(/path and position/i);
    expect(out).not.toMatch(/path and page/i);
  });

  it("tells the model to admit a miss rather than answer from memory", () => {
    // The other half of grounding, and the one a template is least likely to
    // spell out: a retrieval tool that returns nothing is a fact about the
    // corpus, not an invitation to fall back on training data.
    expect(formatWithCitations(results)).toMatch(/say so instead of answering from memory/i);
  });

  it("cites the path the reader recognises, never the container path", () => {
    // The absolute path is what the CONTAINER sees. Showing it in a citation
    // misleads: the customer knows the tree below the mount from Explorer and
    // has never seen "/data/noack". The model can only cite what it is shown,
    // so the leak has to be closed here, in the string. (#933)
    const noack: KnowledgeSearchResult[] = [
      {
        chunkId: "c1",
        text: "Incubate 24 h.",
        sourcePath: "/data/noack/OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf",
        citationPath: "OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf",
        locator: { kind: "page", page: 2 },
        docName: "PI_EColi.pdf",
      },
    ];
    const out = formatWithCitations(noack);
    expect(out).toBe(
      CONTRACT + '[1] OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf (p. 2): "Incubate 24 h."' + LANGUAGE
    );
    expect(out).not.toContain("/data/");
  });

  it("identifies a source by its path, not its bare filename", () => {
    // A real corpus nests documents many levels deep and reuses filenames
    // across folders (the 3M/Noack corpus has ~194 docs under
    // /data/noack/OLD/QF_2012/PrintingFiles_QF/...). A bare basename leaves the
    // reader unable to FIND the document and verify the claim — which is the
    // entire point of cite-then-answer. Found in the 2026-07-16 live Block-A
    // test: the answer was fully grounded, but the citation
    // "PI_EColi-Coliform_Count_Plate.pdf" was unfindable in a 194-document tree.
    const nested: KnowledgeSearchResult[] = [
      {
        chunkId: "c1",
        text: "Incubate 24 h.",
        sourcePath: "/data/noack/OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf",
        citationPath: "OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf",
        locator: { kind: "page", page: 2 },
        docName: "PI_EColi.pdf",
      },
    ];
    const out = formatWithCitations(nested);
    expect(out).toContain("OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf");
  });

  it("distinguishes same-named documents in different folders", () => {
    // The failure a basename cannot express at all: two distinct documents
    // collapse into one indistinguishable citation.
    const collision: KnowledgeSearchResult[] = [
      {
        chunkId: "c1",
        text: "A.",
        sourcePath: "/data/kb/2011/spec.pdf",
        citationPath: "2011/spec.pdf",
        locator: { kind: "page", page: 1 },
        docName: "spec.pdf",
      },
      {
        chunkId: "c2",
        text: "B.",
        sourcePath: "/data/kb/2012/spec.pdf",
        citationPath: "2012/spec.pdf",
        locator: { kind: "page", page: 1 },
        docName: "spec.pdf",
      },
    ];
    const out = formatWithCitations(collision);
    expect(out).toContain("2011/spec.pdf");
    expect(out).toContain("2012/spec.pdf");
  });

  it("renders a Word anchor as its heading path, a slide as its number, a sheet as its rows", () => {
    // Only the page producer exists today; these three are what Wave 2 emits.
    // Pinned now so a later producer cannot quietly invent a second spelling
    // for the same anchor — the whole reason the locator is a closed union.
    const mixed: KnowledgeSearchResult[] = [
      {
        chunkId: "c1",
        text: "Goods are checked on arrival.",
        sourcePath: "/data/noack/QM/handbook.docx",
        citationPath: "QM/handbook.docx",
        locator: { kind: "heading", headings: ["Quality", "Incoming goods"] },
        docName: "handbook.docx",
      },
      {
        chunkId: "c2",
        text: "Q3 revenue was flat.",
        sourcePath: "/data/noack/Sales/review.pptx",
        citationPath: "Sales/review.pptx",
        locator: { kind: "slide", slide: 4 },
        docName: "review.pptx",
      },
      {
        chunkId: "c3",
        text: "Acme GmbH, DE, approved.",
        sourcePath: "/data/noack/Platform/suppliers.xlsx",
        citationPath: "Platform/suppliers.xlsx",
        locator: { kind: "sheet", sheet: "Suppliers", startRow: 5, endRow: 12 },
        docName: "suppliers.xlsx",
      },
    ];
    expect(formatWithCitations(mixed)).toBe(
      CONTRACT +
        '[1] QM/handbook.docx (§ Quality > Incoming goods): "Goods are checked on arrival."\n\n' +
        '[2] Sales/review.pptx (slide 4): "Q3 revenue was flat."\n\n' +
        '[3] Platform/suppliers.xlsx (Suppliers, rows 5-12): "Acme GmbH, DE, approved."' +
        LANGUAGE
    );
  });

  it("returns a deterministic empty-state message for no results", () => {
    expect(formatWithCitations([])).toBe(
      "No matching passages found in the knowledge base. Tell the user, in the language of " +
        "their question, that the knowledge base does not cover this instead of answering " +
        "from memory."
    );
  });

  it("ends with a reminder to answer in the user's language, after the last passage", () => {
    // #1296: a Knowledge Base agent on Claude Haiku 5.5 answered a Polish
    // question in German, because the passages were German. The rule to answer
    // in the user's language was there, twice: SOUL.md and the knowledge-search
    // skill. Both sit far above the tool results, and the skill only reaches
    // the model if it reads SKILL.md first. The last thing the model read
    // before writing was a block of German text, and that won.
    //
    // So this rule trails, unlike the citation contract. The contract is about
    // how to handle the passages and leads them. The language rule is about the
    // answer that comes next, so it goes last, directly before the model starts
    // writing. Without a detected language it names none: the search query
    // is no guide, because the model may write it in the documents' language.
    const out = formatWithCitations(results);
    const lastPassage = out.lastIndexOf('"Snippet two."');
    const reminder = out.indexOf("Write your answer in the language of the user's question");
    expect(lastPassage).toBeGreaterThanOrEqual(0);
    expect(reminder).toBeGreaterThan(lastPassage);
    expect(out.endsWith("quoted wording as written.")).toBe(true);
  });

  it("marks the passages as quoted source material, not conversation", () => {
    // #1296: with a German-named agent, German passages read as the
    // conversation's language. Naming them as quoted documents separates the
    // two. The tags hold the passages only, so the citation contract above
    // still says "as written above" about the paths inside them.
    const out = formatWithCitations(results);
    const open = out.indexOf("<source_passages");
    const close = out.indexOf("</source_passages>");
    expect(open).toBeGreaterThan(out.indexOf("Cite the passages"));
    expect(open).toBeLessThan(out.indexOf("[1] kb/a.pdf"));
    expect(close).toBeGreaterThan(out.lastIndexOf('"Snippet two."'));
    expect(close).toBeLessThan(out.indexOf("Write your answer in the language"));
  });

  it("names the language when it knows the question", () => {
    const out = formatWithCitations(results, {
      language: "Polish",
      text: "Kto podpisał protokół?",
    });
    expect(
      out.endsWith(
        'The question these passages are for was written in Polish: "Kto podpisał protokół?". ' +
          "Write your whole answer to it in Polish (unless the question asks for a different language), even though these passages are in another language: " +
          "translate what they say, and keep document paths, titles and quoted wording as written."
      )
    ).toBe(true);
  });

  it("asks for the miss to be reported in the user's language too", () => {
    // An empty result is the other answer the model writes from this tool's
    // output, and it is just as easy to write in the wrong language: the
    // model may have phrased its query in the documents' language rather
    // than the user's.
    expect(formatWithCitations([])).toMatch(/in the language of their question/);
  });
});

describe("returnedDocumentIds", () => {
  it("dedupes chunks from the same document into a single ref", () => {
    // Keyed on the ABSOLUTE sourcePath, not the citation path: this ref is a
    // document identity for the audit trail, and the trail has to name the
    // path the filesystem answers to.
    const results: KnowledgeSearchResult[] = [
      {
        chunkId: "c1",
        text: "a",
        sourcePath: "/data/kb/a.pdf",
        citationPath: "kb/a.pdf",
        locator: { kind: "page", page: 1 },
        docName: "a.pdf",
      },
      {
        chunkId: "c2",
        text: "b",
        sourcePath: "/data/kb/a.pdf",
        citationPath: "kb/a.pdf",
        locator: { kind: "page", page: 2 },
        docName: "a.pdf",
      },
      {
        chunkId: "c3",
        text: "c",
        sourcePath: "/data/kb/b.pdf",
        citationPath: "kb/b.pdf",
        locator: { kind: "page", page: 1 },
        docName: "b.pdf",
      },
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

describe("answer language (#1296)", () => {
  // Measured on the cross-lingual eval (German-named agent, German sources,
  // Claude Haiku 5.5): the language named in the tool result alone reached
  // about 80 %; adding a fixed system-prompt rule and a per-turn note naming
  // the language reached 94 %. Both come from before_prompt_build.
  function registerWithHook() {
    const api = createMockApi(defaultConfig);
    return import("./index").then(({ default: plugin }) => {
      plugin.register!(api as any);
      const hookCall = api.on.mock.calls.find((c) => c[0] === "before_prompt_build");
      if (!hookCall) throw new Error("before_prompt_build hook not registered");
      const hook = hookCall[1] as (event: unknown, ctx: unknown) => unknown;
      const factory = mockRegisterTool.mock.calls[mockRegisterTool.mock.calls.length - 1][0];
      return { hook, factory };
    });
  }

  const oneResult = () =>
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              chunkId: "c1",
              text: "Die Pumpe ist alle 2000 Betriebsstunden zu warten.",
              sourcePath: "/data/kb/p7.pdf",
              citationPath: "kb/p7.pdf",
              locator: { kind: "page", page: 1 },
              docName: "p7.pdf",
            },
          ],
        }),
        { status: 200 }
      )
    );

  beforeEach(() => {
    mockRegisterTool.mockClear();
  });

  it("adds a fixed answer-language rule to the system prompt", async () => {
    const { hook } = await registerWithHook();
    const a = hook(
      { prompt: "Kto podpisał protokół?", messages: [] },
      { agentId: "agent-1", sessionKey: "s1" }
    ) as {
      appendSystemContext?: string;
    };
    const b = hook(
      { prompt: "AP-2023-091?", messages: [] },
      { agentId: "agent-1", sessionKey: "s2" }
    ) as {
      appendSystemContext?: string;
    };
    expect(a.appendSystemContext).toMatch(/language of the user's latest message/);
    // Identical on every turn and for every message, so the system prompt's
    // prefix (and its prompt cache) never changes because of it.
    expect(b.appendSystemContext).toBe(a.appendSystemContext);
  });

  it("names the message's language in a per-turn note when it can tell", async () => {
    const { hook } = await registerWithHook();
    const result = hook(
      { prompt: "Kto podpisał protokół odbioru AP-2023-091?", messages: [] },
      { agentId: "agent-1", sessionKey: "s1" }
    ) as { appendContext?: string };
    expect(result.appendContext).toBe(
      "(This message is in Polish. Write your whole reply in Polish unless the user has asked for " +
        "another language, even if the documents, your name, your instructions or earlier messages " +
        "are in another language.)"
    );
  });

  it("adds the note only when the language changes, so follow-ups keep the prompt cache", async () => {
    // The note isn't stored, so a turn that carried one replays without it and
    // the cache written over it no longer matches. Noting only the first turn
    // and real switches limits that to one miss per language change.
    const { hook } = await registerWithHook();
    const turn = (prompt: string) =>
      hook({ prompt, messages: [] }, { agentId: "agent-1", sessionKey: "s1" }) as {
        appendContext?: string;
      };
    expect(turn("Kto podpisał protokół odbioru?").appendContext).toMatch(/in Polish/);
    expect(turn("Jaka jest maksymalna temperatura WT-450?").appendContext).toBeUndefined();
    expect(turn("Wer hat das Protokoll unterschrieben?").appendContext).toMatch(/in German/);
    expect(turn("Co ile godzin trzeba serwisować pompę P7?").appendContext).toMatch(/in Polish/);
  });

  it("notes the first turn again after a session reset, which keeps the session key", async () => {
    // Pinchy's reset and Telegram's /new rotate the OpenClaw session in place:
    // same sessionKey, new sessionId. The fresh session has no history in the
    // user's language, so its first turn needs the note as much as any.
    const { hook } = await registerWithHook();
    const turn = (sessionId: string) =>
      hook(
        { prompt: "Kto podpisał protokół odbioru?", messages: [] },
        { agentId: "agent-1", sessionKey: "k", sessionId }
      ) as { appendContext?: string };
    expect(turn("before-reset").appendContext).toMatch(/in Polish/);
    expect(turn("before-reset").appendContext).toBeUndefined();
    expect(turn("after-reset").appendContext).toMatch(/in Polish/);
  });

  it("gives a retried attempt of the same run the note again", async () => {
    // OpenClaw runs before_prompt_build once per attempt. When the first
    // attempt fails (context overflow, a rate limit) the one that answers
    // must not lose the note because the first one already recorded it.
    const { hook } = await registerWithHook();
    const attempt = (runId: string) =>
      hook(
        { prompt: "Kto podpisał protokół odbioru?", messages: [] },
        { agentId: "agent-1", sessionKey: "k", sessionId: "s", runId }
      ) as { appendContext?: string };
    expect(attempt("run-1").appendContext).toMatch(/in Polish/);
    expect(attempt("run-1").appendContext).toMatch(/in Polish/);
    expect(attempt("run-2").appendContext).toBeUndefined();
  });

  it("keeps the run's language on a retry whose prompt OpenClaw extended in English", async () => {
    // Some retries append an English instruction to the prompt (after an
    // empty or reasoning-only response). Re-detecting would read that as
    // English and tell a Polish user's answer to be English.
    const { hook, factory } = await registerWithHook();
    const ctx = { agentId: "agent-1", sessionKey: "k", sessionId: "s", runId: "run-1" };
    hook({ prompt: "Kto podpisał protokół odbioru?", messages: [] }, ctx);
    const retry = hook(
      {
        prompt:
          // OpenClaw's EMPTY_RESPONSE_RETRY_INSTRUCTION, as appended on a retry.
          "Kto podpisał protokół odbioru?\n\nThe previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.",
        messages: [],
      },
      ctx
    ) as { appendContext?: string };
    expect(retry.appendContext).toMatch(/in Polish/);
    global.fetch = oneResult();
    const tool = factory({ agentId: "agent-1", sessionKey: "k" });
    const text = (await tool.execute("call-1", { query: "Abnahmeprotokoll" })).content[0]
      .text as string;
    expect(text).toContain("written in Polish");
  });

  it("notes each session's first turn on its own", async () => {
    const { hook } = await registerWithHook();
    const first = (sessionKey: string) =>
      hook(
        { prompt: "Kto podpisał protokół odbioru?", messages: [] },
        { agentId: "agent-1", sessionKey }
      ) as { appendContext?: string };
    expect(first("a").appendContext).toMatch(/in Polish/);
    expect(first("b").appendContext).toMatch(/in Polish/);
  });

  it("adds no per-turn note when it can't tell the language", async () => {
    const { hook } = await registerWithHook();
    const result = hook(
      { prompt: "AP-2023-091?", messages: [] },
      { agentId: "agent-1", sessionKey: "s1" }
    ) as { appendContext?: string };
    expect(result.appendContext).toBeUndefined();
  });

  it("leaves agents without knowledge_search alone", async () => {
    const { hook } = await registerWithHook();
    expect(
      hook(
        { prompt: "Kto podpisał protokół?", messages: [] },
        { agentId: "agent-without-kb", sessionKey: "s1" }
      )
    ).toBeUndefined();
  });

  it("is re-checked when OpenClaw is bumped", () => {
    // The per-turn note is not stored in the transcript, so a later turn
    // replays the user's message without it. A Claude model with preserved
    // thinking refuses a thinking block whose prefix changed. Today that can't
    // happen: the only such model Pinchy offers, Claude Haiku 5.5, runs with
    // thinking off on this OpenClaw version. A newer OpenClaw may turn it on.
    // When this fails, check that Haiku 5.5 with thinking still answers a
    // second turn after a note, then update the pinned version here.
    const runtime = JSON.parse(
      readFileSync(join(__dirname, "../../openclaw-runtime/package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(runtime.dependencies.openclaw).toBe("2026.7.1-2");
  });

  it("names the question's language and quotes the question after the passages", async () => {
    const { hook, factory } = await registerWithHook();
    hook(
      { prompt: "Co ile godzin pracy trzeba serwisować pompę P7?", messages: [] },
      { agentId: "agent-1", sessionKey: "s1" }
    );
    global.fetch = oneResult();
    const tool = factory({ agentId: "agent-1", sessionKey: "s1" });
    const text = (await tool.execute("call-1", { query: "Wartungsintervall Pumpe P7" })).content[0]
      .text as string;
    expect(
      text.endsWith(
        'The question these passages are for was written in Polish: "Co ile godzin pracy trzeba serwisować pompę P7?". ' +
          "Write your whole answer to it in Polish (unless the question asks for a different language), even though these passages are in another language: " +
          "translate what they say, and keep document paths, titles and quoted wording as written."
      )
    ).toBe(true);
  });

  it("quotes what the user typed, not the attachment block Pinchy appended", async () => {
    const { hook, factory } = await registerWithHook();
    hook(
      {
        prompt:
          "Kto podpisał ten protokół?\n\n<pinchy:attachments>\n- `/root/.openclaw/workspaces/a1/uploads/p.pdf` (application/pdf, 1 MB) — analyze with pinchy_read\n</pinchy:attachments>",
        messages: [],
      },
      { agentId: "agent-1", sessionKey: "s1" }
    );
    global.fetch = oneResult();
    const tool = factory({ agentId: "agent-1", sessionKey: "s1" });
    const text = (await tool.execute("call-1", { query: "Abnahmeprotokoll" })).content[0]
      .text as string;
    expect(text).toContain('written in Polish: "Kto podpisał ten protokół?".');
    expect(text).not.toContain("pinchy:attachments");
    expect(text).not.toContain("/root/.openclaw");
  });

  it("leaves room for a user who asks for another language", () => {
    // "Bitte auf Englisch: …" is German but asks for English. The sentence the
    // model reads last must not overrule that request.
    const named = formatWithCitations(
      [
        {
          chunkId: "c1",
          text: "x",
          sourcePath: "/data/a.pdf",
          citationPath: "a.pdf",
          locator: null,
          docName: "a.pdf",
        },
      ],
      { language: "German", text: "Bitte auf Englisch: Was steht im Bericht?" }
    );
    expect(named).toMatch(/unless the question asks for a different language/);
    const unnamed = formatWithCitations([
      {
        chunkId: "c1",
        text: "x",
        sourcePath: "/data/a.pdf",
        citationPath: "a.pdf",
        locator: null,
        docName: "a.pdf",
      },
    ]);
    expect(unnamed).toMatch(/unless the question asks for a different language/);
  });

  it("keeps sessions apart", async () => {
    const { hook, factory } = await registerWithHook();
    hook(
      { prompt: "Kto podpisał protokół odbioru AP-2023-091?", messages: [] },
      { agentId: "agent-1", sessionKey: "polish-chat" }
    );
    global.fetch = oneResult();
    const tool = factory({ agentId: "agent-1", sessionKey: "other-chat" });
    const text = (await tool.execute("call-1", { query: "Abnahmeprotokoll" })).content[0]
      .text as string;
    expect(text).not.toMatch(/Polish/);
    expect(text).toMatch(/Write your answer in the language of the user's question/);
  });

  it("falls back to the unnamed wording when the language is unclear", async () => {
    // A message the detector can't place must not inherit the previous
    // question's language: that would name the wrong one with confidence.
    const { hook, factory } = await registerWithHook();
    hook(
      { prompt: "Kto podpisał protokół odbioru AP-2023-091?", messages: [] },
      { agentId: "agent-1", sessionKey: "s1" }
    );
    hook({ prompt: "AP-2023-091?", messages: [] }, { agentId: "agent-1", sessionKey: "s1" });
    global.fetch = oneResult();
    const tool = factory({ agentId: "agent-1", sessionKey: "s1" });
    const text = (await tool.execute("call-1", { query: "AP-2023-091" })).content[0].text as string;
    expect(text).not.toMatch(/Polish/);
    expect(text).toMatch(/Write your answer in the language of the user's question/);
  });

  it("ignores agents without knowledge_search", async () => {
    const { hook, factory } = await registerWithHook();
    hook(
      { prompt: "Kto podpisał protokół odbioru AP-2023-091?", messages: [] },
      { agentId: "agent-without-kb", sessionKey: "s1" }
    );
    global.fetch = oneResult();
    const tool = factory({ agentId: "agent-1", sessionKey: "s1" });
    const text = (await tool.execute("call-1", { query: "Abnahmeprotokoll" })).content[0]
      .text as string;
    expect(text).not.toMatch(/Polish/);
  });
});

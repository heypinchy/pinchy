import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockValidateGatewayToken = vi.fn();
vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: (...args: unknown[]) => mockValidateGatewayToken(...args),
}));

const mockLimit = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
vi.mock("@/db", () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}));

// activeAgents is referenced only as a query target; a sentinel is enough.
vi.mock("@/db/schema", () => ({
  activeAgents: { __table: "active_agents", id: "active_agents.id" },
}));

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

const mockRetrieve = vi.fn();
vi.mock("@/lib/knowledge/retrieve", () => ({
  retrieve: (...args: unknown[]) => mockRetrieve(...args),
}));

const mockEmbedTexts = vi.fn();
vi.mock("@/lib/knowledge/embeddings", () => ({
  embedTexts: (...args: unknown[]) => mockEmbedTexts(...args),
}));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(body: unknown, token = "correct-token") {
  return new NextRequest("http://localhost/api/internal/knowledge/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const validBody = { query: "What is our vacation policy?", agentId: "agent-1" };

const agentRow = {
  id: "agent-1",
  name: "Smithers",
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr"] } },
};

const retrievedChunks = [
  {
    chunkId: "chunk-1",
    documentId: "doc-1",
    text: "Employees get 25 days of vacation per year.",
    sourcePath: "/data/hr/handbook.pdf",
    page: 4,
    score: 0.9,
  },
  {
    chunkId: "chunk-2",
    documentId: "doc-1",
    text: "Unused vacation carries over up to 5 days.",
    sourcePath: "/data/hr/handbook.pdf",
    page: 5,
    score: 0.7,
  },
];

describe("POST /api/internal/knowledge/search", () => {
  let POST: typeof import("@/app/api/internal/knowledge/search/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockValidateGatewayToken.mockReturnValue(true);
    mockLimit.mockResolvedValue([agentRow]);
    mockGetSetting.mockResolvedValue("http://ollama.local:11434");
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
    mockRetrieve.mockResolvedValue(retrievedChunks);
    POST = (await import("@/app/api/internal/knowledge/search/route")).POST;
  });

  it("returns 401 and never calls retrieve when the gateway token is invalid", async () => {
    mockValidateGatewayToken.mockReturnValueOnce(false);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns 401 and never calls retrieve when the Authorization header is missing", async () => {
    mockValidateGatewayToken.mockReturnValueOnce(false);
    const res = await POST(makeRequest(validBody, ""));
    expect(res.status).toBe(401);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns 400 via parseRequestBody when the query is missing", async () => {
    const res = await POST(makeRequest({ agentId: "agent-1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns 400 via parseRequestBody when agentId is missing", async () => {
    const res = await POST(makeRequest({ query: "hello" }));
    expect(res.status).toBe(400);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns 200 with the results shape mapped from retrieve()", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      results: [
        {
          chunkId: "chunk-1",
          text: "Employees get 25 days of vacation per year.",
          sourcePath: "/data/hr/handbook.pdf",
          page: 4,
          docName: "handbook.pdf",
        },
        {
          chunkId: "chunk-2",
          text: "Unused vacation carries over up to 5 days.",
          sourcePath: "/data/hr/handbook.pdf",
          page: 5,
          docName: "handbook.pdf",
        },
      ],
    });
  });

  it("resolves agentId -> allowedPaths from the agent's pinchy-files admin config and denies by default with []", async () => {
    mockLimit.mockResolvedValueOnce([{ id: "agent-1", name: "Smithers", pluginConfig: null }]);
    await POST(makeRequest(validBody));
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    const [, allowedPaths] = mockRetrieve.mock.calls[0];
    expect(allowedPaths).toEqual([]);
  });

  it("passes the agent's configured allowed_paths through to retrieve()", async () => {
    await POST(makeRequest(validBody));
    const [, allowedPaths] = mockRetrieve.mock.calls[0];
    expect(allowedPaths).toEqual(["/data/hr"]);
  });

  it("returns 404 and never calls retrieve when the agent does not exist (or is deleted)", async () => {
    mockLimit.mockResolvedValueOnce([]);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(404);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("writes a retrieval.query audit row with outcome success, {id,name} document refs, a queryHash, and no plaintext query", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];

    expect(entry.eventType).toBe("retrieval.query");
    expect(entry.outcome).toBe("success");
    expect(entry.detail.resultCount).toBe(2);
    expect(entry.detail.returnedDocumentIds).toEqual([{ id: "doc-1", name: "handbook.pdf" }]);
    expect(entry.detail.agent).toEqual({ id: "agent-1", name: "Smithers" });

    // No plaintext PII: the raw query text must never appear anywhere in the
    // serialized audit entry, only a hash of it.
    expect(typeof entry.detail.queryHash).toBe("string");
    expect(entry.detail.queryHash).not.toBe(validBody.query);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(validBody.query);
    expect(serialized).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/); // no email-shaped strings
  });

  it("audits a failure outcome (and still surfaces an error response) when retrieve() throws", async () => {
    mockRetrieve.mockRejectedValueOnce(new Error("db unavailable"));
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(502);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("retrieval.query");
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.resultCount).toBe(0);
  });

  it("wires embedTexts(bge-m3) as the retrieve() embedder using the configured local Ollama URL", async () => {
    await POST(makeRequest(validBody));
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    const deps = mockRetrieve.mock.calls[0][3];
    await deps.embed(["hello"]);
    expect(mockEmbedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ baseUrl: "http://ollama.local:11434" })
    );
  });
});

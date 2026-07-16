import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockLimit = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
vi.mock("@/db", () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}));

vi.mock("@/db/schema", () => ({
  activeAgents: { __table: "active_agents", id: "active_agents.id" },
}));

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

const mockIngestDirectory = vi.fn();
vi.mock("@/lib/knowledge/ingest", () => ({
  ingestDirectory: (...args: unknown[]) => mockIngestDirectory(...args),
}));

const mockEmbedTexts = vi.fn();
vi.mock("@/lib/knowledge/embeddings", () => ({
  embedTexts: (...args: unknown[]) => mockEmbedTexts(...args),
}));

const mockExtractPdfPages = vi.fn();
vi.mock("@/lib/knowledge/pdf-extract", () => ({
  extractPdfPages: (...args: unknown[]) => mockExtractPdfPages(...args),
}));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/agents/agent-1/knowledge/reindex", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const agentRow = {
  id: "agent-1",
  name: "Smithers",
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr", "/data/legal"] } },
};

describe("POST /api/agents/[agentId]/knowledge/reindex", () => {
  let POST: typeof import("@/app/api/agents/[agentId]/knowledge/reindex/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockLimit.mockResolvedValue([agentRow]);
    mockGetSetting.mockResolvedValue("http://ollama.local:11434");
    mockIngestDirectory.mockResolvedValue({ indexed: 2, skipped: 1, removed: 0 });
    POST = (await import("@/app/api/agents/[agentId]/knowledge/reindex/route")).POST;
  });

  it("returns 401 when unauthenticated and never ingests", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(401);
    expect(mockIngestDirectory).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated non-admin and never ingests", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-1", role: "member" } });
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(403);
    expect(mockIngestDirectory).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent does not exist (or is deleted) and never ingests", async () => {
    mockLimit.mockResolvedValueOnce([]);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(404);
    expect(mockIngestDirectory).not.toHaveBeenCalled();
  });

  it("reindexes every granted folder and aggregates counts across paths", async () => {
    mockIngestDirectory
      .mockResolvedValueOnce({ indexed: 2, skipped: 1, removed: 0 })
      .mockResolvedValueOnce({ indexed: 3, skipped: 0, removed: 1 });

    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ indexed: 5, skipped: 1, removed: 1, pathCount: 2 });

    expect(mockIngestDirectory).toHaveBeenCalledTimes(2);
    // Each granted folder is ingested with the shared single-tenant org id.
    expect(mockIngestDirectory.mock.calls[0][0]).toBe(DEFAULT_ORG_ID);
    expect(mockIngestDirectory.mock.calls[0][1]).toBe("/data/hr");
    expect(mockIngestDirectory.mock.calls[1][0]).toBe(DEFAULT_ORG_ID);
    expect(mockIngestDirectory.mock.calls[1][1]).toBe("/data/legal");
    // The production deps (embed + extractPdf) are passed as the third arg.
    const deps = mockIngestDirectory.mock.calls[0][2];
    expect(typeof deps.embed).toBe("function");
    expect(typeof deps.extractPdf).toBe("function");
  });

  it("narrows to the requested subset but never past the agent's granted folders", async () => {
    // /data/legal is granted; /etc/passwd is NOT — it must be dropped, not ingested.
    const res = await POST(makeRequest({ paths: ["/data/legal", "/etc/passwd"] }), ctx as never);
    expect(res.status).toBe(200);
    expect(mockIngestDirectory).toHaveBeenCalledTimes(1);
    expect(mockIngestDirectory.mock.calls[0][1]).toBe("/data/legal");
  });

  it("returns 200 with zero counts and never ingests when the agent has no granted folders", async () => {
    mockLimit.mockResolvedValueOnce([{ id: "agent-1", name: "Smithers", pluginConfig: null }]);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ indexed: 0, skipped: 0, removed: 0, pathCount: 0 });
    expect(mockIngestDirectory).not.toHaveBeenCalled();

    // A no-op reindex is still audited (success, zero counts).
    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.reindex");
    expect(entry.outcome).toBe("success");
    expect(entry.detail.pathCount).toBe(0);
  });

  it("returns 503 and audits a failure when the embedding endpoint is not configured", async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(503);
    expect(mockIngestDirectory).not.toHaveBeenCalled();

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.reindex");
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.reason).toBe("ollama_not_configured");
  });

  it("returns 500 and audits a failure when ingest throws", async () => {
    mockIngestDirectory.mockRejectedValueOnce(new Error("disk exploded"));
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(500);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.reindex");
    expect(entry.outcome).toBe("failure");
  });

  it("writes a knowledge.reindex audit row with {id,name} agent ref, counts, and no raw filesystem path/PII", async () => {
    mockIngestDirectory
      .mockResolvedValueOnce({ indexed: 2, skipped: 1, removed: 0 })
      .mockResolvedValueOnce({ indexed: 3, skipped: 0, removed: 1 });

    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(200);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.reindex");
    expect(entry.outcome).toBe("success");
    expect(entry.detail.agent).toEqual({ id: "agent-1", name: "Smithers" });
    expect(entry.detail).toMatchObject({ pathCount: 2, indexed: 5, skipped: 1, removed: 1 });

    // No full filesystem paths (which can embed usernames) in the audit detail.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("/data/hr");
    expect(serialized).not.toContain("/data/legal");
    expect(serialized).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/); // no email-shaped strings
  });
});

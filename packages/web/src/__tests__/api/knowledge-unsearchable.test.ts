/**
 * Route tests for GET /api/agents/[agentId]/knowledge/unsearchable (#935).
 *
 * These cover the ACCESS boundary — who may ask, and which paths the question
 * is asked about. Whether the SQL then answers it correctly is a database
 * question, pinned against a real Postgres in
 * lib/knowledge/unsearchable.integration.test.ts.
 */
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

const mockListUnsearchableDocuments = vi.fn();
vi.mock("@/lib/knowledge/unsearchable", () => ({
  listUnsearchableDocuments: (...args: unknown[]) => mockListUnsearchableDocuments(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const makeRequest = () =>
  new NextRequest("http://localhost/api/agents/agent-1/knowledge/unsearchable");

const agentRow = {
  id: "agent-1",
  name: "Smithers",
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr", "/data/legal"] } },
};

describe("GET /api/agents/[agentId]/knowledge/unsearchable", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/knowledge/unsearchable/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockLimit.mockResolvedValue([agentRow]);
    mockListUnsearchableDocuments.mockResolvedValue({ documents: [], total: 0 });
    GET = (await import("@/app/api/agents/[agentId]/knowledge/unsearchable/route")).GET;
  });

  it("returns 401 when unauthenticated and never queries", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(401);
    expect(mockListUnsearchableDocuments).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated non-admin and never queries", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-1", role: "member" } });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(403);
    expect(mockListUnsearchableDocuments).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown agent and never queries", async () => {
    mockLimit.mockResolvedValueOnce([]);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(404);
    expect(mockListUnsearchableDocuments).not.toHaveBeenCalled();
  });

  // The security boundary of this route: the scope comes from the agent's
  // SAVED grants, never from the request. A route that took a path from the
  // query string would let an admin enumerate documents an agent was never
  // granted — the exact thing the allow-list exists to prevent.
  it("scopes the query to the agent's granted directories", async () => {
    await GET(makeRequest(), ctx as never);

    expect(mockListUnsearchableDocuments).toHaveBeenCalledWith(DEFAULT_ORG_ID, [
      "/data/hr",
      "/data/legal",
    ]);
  });

  it("scopes to nothing when the agent has no pinchy-files grants", async () => {
    mockLimit.mockResolvedValueOnce([{ id: "agent-1", name: "Smithers", pluginConfig: null }]);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(mockListUnsearchableDocuments).toHaveBeenCalledWith(DEFAULT_ORG_ID, []);
  });

  it("returns the documents and the untruncated total", async () => {
    mockListUnsearchableDocuments.mockResolvedValueOnce({
      documents: [
        { sourcePath: "/data/hr/AFNOR validation.pdf", status: "active" },
        { sourcePath: "/data/hr/OLD/Expired ISO.pdf", status: "archived" },
      ],
      total: 25,
    });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      documents: [
        { sourcePath: "/data/hr/AFNOR validation.pdf", status: "active" },
        { sourcePath: "/data/hr/OLD/Expired ISO.pdf", status: "archived" },
      ],
      total: 25,
    });
  });
});

/**
 * Route tests for GET /api/agents/[agentId]/knowledge/unsearchable (#935).
 *
 * These cover the ACCESS boundary — who may ask, and which paths the question
 * is asked about. Whether the SQL then answers it correctly is a database
 * question, pinned against a real Postgres in
 * lib/knowledge/unsearchable.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

// The route no longer looks the agent up itself: it asks the shared read gate,
// which is what withholds another user's personal agent from an admin. Mocking
// the helper (rather than `@/db`) is what lets this file assert the delegation;
// the helper's own rule is pinned in lib/agent-access.test.ts, and the
// end-to-end answer against a real DB in
// agent-admin-routes-visibility.integration.test.ts.
const mockGetAgentWithAccess = vi.fn();
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: (...args: unknown[]) => mockGetAgentWithAccess(...args),
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
  allowedTools: ["knowledge_search"],
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr", "/data/legal"] } },
};

const noTotals = { no_text: 0, awaiting_conversion: 0 };

describe("GET /api/agents/[agentId]/knowledge/unsearchable", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/knowledge/unsearchable/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockGetAgentWithAccess.mockResolvedValue(agentRow);
    mockListUnsearchableDocuments.mockResolvedValue({ documents: [], total: 0, totals: noTotals });
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
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(404);
    expect(mockListUnsearchableDocuments).not.toHaveBeenCalled();
  });

  it("asks the read gate with the caller's identity, not just the agent id", async () => {
    // Being admin-only is not a visibility rule. The gate is what withholds
    // another user's personal agent, and it can only do that if the route
    // hands it who is asking — the answer differs per caller, not per role.
    await GET(makeRequest(), ctx as never);

    expect(mockGetAgentWithAccess).toHaveBeenCalledWith("agent-1", "admin-1", "admin");
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
    mockGetAgentWithAccess.mockResolvedValueOnce({
      id: "agent-1",
      name: "Smithers",
      allowedTools: [],
      pluginConfig: null,
    });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(mockListUnsearchableDocuments).toHaveBeenCalledWith(DEFAULT_ORG_ID, []);
  });

  it("returns the documents, the untruncated total and the total per reason", async () => {
    mockListUnsearchableDocuments.mockResolvedValueOnce({
      documents: [
        { sourcePath: "/data/hr/AFNOR validation.pdf", status: "active", reason: "no_text" },
        { sourcePath: "/data/hr/OLD/Expired ISO.pdf", status: "archived", reason: "no_text" },
      ],
      total: 25,
      totals: { no_text: 21, awaiting_conversion: 4 },
    });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      documents: [
        { sourcePath: "/data/hr/AFNOR validation.pdf", status: "active", reason: "no_text" },
        { sourcePath: "/data/hr/OLD/Expired ISO.pdf", status: "archived", reason: "no_text" },
      ],
      total: 25,
      totals: { no_text: 21, awaiting_conversion: 4 },
      searchesIndex: true,
    });
  });

  // Who converts a file waiting to be converted again depends on this: Pinchy
  // queues that run on its own only for agents that search the index
  // (office-format-upgrade.ts), so for any other agent it takes a reindex.
  it("says the agent doesn't search the index when it lacks knowledge_search", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce({ ...agentRow, allowedTools: ["pinchy_read"] });

    const res = await GET(makeRequest(), ctx as never);

    expect((await res.json()).searchesIndex).toBe(false);
  });
});

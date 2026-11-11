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
const mockSummarizeUnsearchableDocuments = vi.fn();
vi.mock("@/lib/knowledge/unsearchable", () => ({
  listUnsearchableDocuments: (...args: unknown[]) => mockListUnsearchableDocuments(...args),
  summarizeUnsearchableDocuments: (...args: unknown[]) =>
    mockSummarizeUnsearchableDocuments(...args),
}));

// Whether a run started now would read scans is the server's answer, not the
// page's guess (#1362): the route asks for it and hands it to the query.
const OCR_OFF = { state: "off" } as const;
const mockKbOcrAvailability = vi.fn();
vi.mock("@/lib/knowledge/kb-ocr", () => ({
  kbOcrAvailability: (...args: unknown[]) => mockKbOcrAvailability(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const makeRequest = (query = "") =>
  new NextRequest(`http://localhost/api/agents/agent-1/knowledge/unsearchable${query}`);

const agentRow = {
  id: "agent-1",
  name: "Smithers",
  allowedTools: ["knowledge_search"],
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr", "/data/legal"] } },
};

const emptySummary = {
  total: 0,
  totals: { no_text: 0, awaiting_conversion: 0 },
  causes: { ocr_off: 0, no_vision_model: 0, read_next_run: 0, read_blank: 0 },
  groups: [],
};

/** Every query either read path would make; "never queries" means none of them. */
const queried = () =>
  mockSummarizeUnsearchableDocuments.mock.calls.length +
  mockListUnsearchableDocuments.mock.calls.length;

describe("GET /api/agents/[agentId]/knowledge/unsearchable", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/knowledge/unsearchable/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockGetAgentWithAccess.mockResolvedValue(agentRow);
    mockKbOcrAvailability.mockResolvedValue(OCR_OFF);
    mockSummarizeUnsearchableDocuments.mockResolvedValue(emptySummary);
    mockListUnsearchableDocuments.mockResolvedValue({ documents: [], total: 0 });
    GET = (await import("@/app/api/agents/[agentId]/knowledge/unsearchable/route")).GET;
  });

  it("returns 401 when unauthenticated and never queries", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(401);
    expect(queried()).toBe(0);
  });

  it("returns 403 for an authenticated non-admin and never queries", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-1", role: "member" } });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(403);
    expect(queried()).toBe(0);
  });

  it("returns 404 for an unknown agent and never queries", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(404);
    expect(queried()).toBe(0);
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
  it("scopes the summary to the agent's granted directories and the server's OCR setup", async () => {
    await GET(makeRequest(), ctx as never);

    expect(mockSummarizeUnsearchableDocuments).toHaveBeenCalledWith(
      DEFAULT_ORG_ID,
      ["/data/hr", "/data/legal"],
      OCR_OFF
    );
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
    expect(mockSummarizeUnsearchableDocuments).toHaveBeenCalledWith(DEFAULT_ORG_ID, [], OCR_OFF);
  });

  it("returns the counts per reason, per cause and per folder", async () => {
    const summary = {
      total: 25,
      totals: { no_text: 21, awaiting_conversion: 4 },
      causes: { ocr_off: 20, no_vision_model: 0, read_next_run: 0, read_blank: 1 },
      groups: [
        { root: "/data/hr", folder: "Certificates", count: 19 },
        { root: "/data/legal", folder: null, count: 6 },
      ],
    };
    mockSummarizeUnsearchableDocuments.mockResolvedValueOnce(summary);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...summary, searchesIndex: true });
    expect(mockListUnsearchableDocuments).not.toHaveBeenCalled();
  });

  // ── One folder's documents (#1364) ───────────────────────────────────────

  it("lists one folder's documents when asked for a group", async () => {
    const page = {
      documents: [
        {
          sourcePath: "/data/hr/Certificates/AFNOR.pdf",
          name: "AFNOR.pdf",
          root: "/data/hr",
          folder: "Certificates",
          status: "active",
          reason: "no_text",
          cause: "ocr_off",
        },
      ],
      total: 19,
    };
    mockListUnsearchableDocuments.mockResolvedValueOnce(page);

    const res = await GET(makeRequest("?root=%2Fdata%2Fhr&folder=Certificates"), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(page);
    expect(mockListUnsearchableDocuments).toHaveBeenCalledWith(
      DEFAULT_ORG_ID,
      ["/data/hr", "/data/legal"],
      OCR_OFF,
      { group: { root: "/data/hr", folder: "Certificates" } }
    );
  });

  it("reads a group without a folder as the files directly in the grant", async () => {
    await GET(makeRequest("?root=%2Fdata%2Flegal"), ctx as never);

    expect(mockListUnsearchableDocuments).toHaveBeenCalledWith(
      DEFAULT_ORG_ID,
      ["/data/hr", "/data/legal"],
      OCR_OFF,
      { group: { root: "/data/legal", folder: null } }
    );
  });

  // The group's root picks one of the agent's grants; it never adds one. The
  // query itself refuses a root outside the grants (pinned in
  // unsearchable.integration.test.ts) — what the route owes is to pass the
  // SAVED grants as the scope whatever the request names.
  it("keeps the saved grants as the scope when the request names another root", async () => {
    await GET(makeRequest("?root=%2Fetc"), ctx as never);

    expect(mockListUnsearchableDocuments).toHaveBeenCalledWith(
      DEFAULT_ORG_ID,
      ["/data/hr", "/data/legal"],
      OCR_OFF,
      { group: { root: "/etc", folder: null } }
    );
  });

  // A group is ONE folder below the grant. A nested path would be a way to
  // ask for a subtree the page never offered, so it is refused rather than
  // quietly answered with nothing.
  it.each([
    ["a folder that is a path", "?root=%2Fdata%2Fhr&folder=Certificates%2F2024"],
    ["an empty folder", "?root=%2Fdata%2Fhr&folder="],
    ["a folder without a root", "?folder=Certificates"],
    ["an empty root", "?root="],
  ])("answers 400 for %s and never queries", async (_label, query) => {
    const res = await GET(makeRequest(query), ctx as never);

    expect(res.status).toBe(400);
    expect(queried()).toBe(0);
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

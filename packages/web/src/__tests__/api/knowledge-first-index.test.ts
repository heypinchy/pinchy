/**
 * Route tests for GET /api/agents/[agentId]/knowledge/first-index (#1280).
 *
 * The access boundary only: who may ask, and that the answer is the agent's
 * first-index status and nothing more. What that status is for a given set of
 * runs is a database question, pinned in
 * lib/knowledge/first-index.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockGetAgentWithAccess = vi.fn();
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: (...args: unknown[]) => mockGetAgentWithAccess(...args),
}));

const mockGetFirstIndexStatus = vi.fn();
vi.mock("@/lib/knowledge/first-index", () => ({
  getFirstIndexStatus: (...args: unknown[]) => mockGetFirstIndexStatus(...args),
}));

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };
const makeRequest = () =>
  new NextRequest("http://localhost/api/agents/agent-1/knowledge/first-index");

const agentRow = {
  id: "agent-1",
  name: "Handbook",
  deletedAt: null,
  allowedTools: ["knowledge_search"],
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr"] } },
};

describe("GET /api/agents/[agentId]/knowledge/first-index", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/knowledge/first-index/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    mockGetAgentWithAccess.mockResolvedValue(agentRow);
    mockGetFirstIndexStatus.mockResolvedValue({ state: "indexing", processed: 120, total: 505 });
    GET = (await import("@/app/api/agents/[agentId]/knowledge/first-index/route")).GET;
  });

  it("returns 401 when unauthenticated and never looks", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(401);
    expect(mockGetFirstIndexStatus).not.toHaveBeenCalled();
  });

  it("answers anyone who may chat with the agent, not only admins", async () => {
    // A member opening a fresh agent's chat is exactly who needs to know its
    // documents are still being read.
    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "indexing", processed: 120, total: 505 });
    expect(mockGetAgentWithAccess).toHaveBeenCalledWith("agent-1", "user-1", "member");
    expect(mockGetFirstIndexStatus).toHaveBeenCalledWith(agentRow);
  });

  it("answers the read gate's refusal unchanged and never looks", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(404);
    expect(mockGetFirstIndexStatus).not.toHaveBeenCalled();
  });
});

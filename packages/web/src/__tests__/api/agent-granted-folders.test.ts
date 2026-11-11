/**
 * Route tests for GET /api/agents/[agentId]/granted-folders (#1363).
 *
 * These cover the ACCESS boundary — who may ask, and which paths are checked.
 * What a check answers for a real folder, a missing one, an unreadable one or
 * a link is pinned against a real file system in
 * lib/granted-folder-status.test.ts.
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

const mockCheckGrantedFolders = vi.fn();
vi.mock("@/lib/granted-folder-status", () => ({
  checkGrantedFolders: (...args: unknown[]) => mockCheckGrantedFolders(...args),
}));

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const makeRequest = (query = "") =>
  new NextRequest(`http://localhost/api/agents/agent-1/granted-folders${query}`);

const agentRow = {
  id: "agent-1",
  name: "Supplier Docs",
  allowedTools: ["knowledge_search"],
  pluginConfig: {
    "pinchy-files": {
      // The last entry predates the /data lockdown: it is not a grant, and
      // the route must not check it (grantedDataPaths drops it).
      allowed_paths: ["/data/old-name/", "/data/suppliers/food/", "/root/.openclaw/workspaces/"],
    },
  },
};

describe("GET /api/agents/[agentId]/granted-folders", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/granted-folders/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockGetAgentWithAccess.mockResolvedValue(agentRow);
    mockCheckGrantedFolders.mockImplementation(async (paths: string[]) =>
      paths.map((path) => ({ path, status: "available" }))
    );
    GET = (await import("@/app/api/agents/[agentId]/granted-folders/route")).GET;
  });

  it("returns 401 when unauthenticated and checks nothing", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(401);
    expect(mockCheckGrantedFolders).not.toHaveBeenCalled();
  });

  // A member may be able to save grants on their own agent. If they could
  // then ask which of those exist, saving and asking would together probe any
  // path under /data — so the question is an admin's, like browsing
  // subfolders is.
  it("returns 403 for a member and checks nothing", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-1", role: "member" } });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(403);
    expect(mockCheckGrantedFolders).not.toHaveBeenCalled();
  });

  it("returns the read gate's 404 and checks nothing", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(404);
    expect(mockCheckGrantedFolders).not.toHaveBeenCalled();
  });

  it("asks the read gate with the caller's identity", async () => {
    await GET(makeRequest(), ctx as never);

    expect(mockGetAgentWithAccess).toHaveBeenCalledWith("agent-1", "admin-1", "admin");
  });

  it("checks the agent's saved grants under /data only, never a path from the request", async () => {
    await GET(makeRequest("?path=/etc&paths=/root"), ctx as never);

    expect(mockCheckGrantedFolders).toHaveBeenCalledTimes(1);
    expect(mockCheckGrantedFolders).toHaveBeenCalledWith([
      "/data/old-name/",
      "/data/suppliers/food/",
    ]);
  });

  it("returns each grant with its status", async () => {
    mockCheckGrantedFolders.mockResolvedValueOnce([
      { path: "/data/old-name/", status: "missing" },
      { path: "/data/suppliers/food/", status: "available" },
    ]);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folders: [
        { path: "/data/old-name/", status: "missing" },
        { path: "/data/suppliers/food/", status: "available" },
      ],
    });
  });
});

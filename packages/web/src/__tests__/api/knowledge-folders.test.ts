/**
 * Route tests for the knowledge folder status and file list (#1386):
 *   GET /api/agents/[agentId]/knowledge/folders
 *   GET /api/agents/[agentId]/knowledge/files
 *
 * These cover the ACCESS boundary. The counts are pinned against a real
 * Postgres in lib/knowledge/index-status.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";

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

const mockGetFolderStatus = vi.fn();
const mockListFiles = vi.fn();
vi.mock("@/lib/knowledge/index-status", () => ({
  getKnowledgeFolderStatus: (...args: unknown[]) => mockGetFolderStatus(...args),
  listKnowledgeFolderFiles: (...args: unknown[]) => mockListFiles(...args),
}));

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };
const agentRow = {
  id: "agent-1",
  name: "Docs",
  allowedTools: ["knowledge_search"],
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr"] } },
};
const notFound = () => NextResponse.json({ error: "Agent not found" }, { status: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "member-1", role: "member" } });
  mockGetAgentWithAccess.mockResolvedValue(agentRow);
  mockGetFolderStatus.mockResolvedValue({ folders: [], job: null });
  mockListFiles.mockResolvedValue({
    folder: "/data/hr",
    files: [],
    total: 0,
    totals: { all: 0, searchable: 0, notSearchable: 0 },
    truncated: false,
  });
});

describe("GET /api/agents/[agentId]/knowledge/folders", () => {
  const request = () => new NextRequest("http://localhost/api/agents/agent-1/knowledge/folders");
  const load = async () => (await import("@/app/api/agents/[agentId]/knowledge/folders/route")).GET;

  it("returns 401 when unauthenticated and never queries", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await (await load())(request(), ctx as never);
    expect(res.status).toBe(401);
    expect(mockGetFolderStatus).not.toHaveBeenCalled();
  });

  // "Why doesn't it know about X?" is a member's question first.
  it("lets a member who can open the agent read its folder status", async () => {
    const res = await (await load())(request(), ctx as never);
    expect(res.status).toBe(200);
    expect(mockGetAgentWithAccess).toHaveBeenCalledWith("agent-1", "member-1", "member");
    expect(await res.json()).toEqual({ folders: [], job: null });
  });

  it("answers 404 to a user the agent gate refuses, and never queries", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "other-1", role: "member" } });
    mockGetAgentWithAccess.mockResolvedValueOnce(notFound());
    const res = await (await load())(request(), ctx as never);
    expect(res.status).toBe(404);
    expect(mockGetFolderStatus).not.toHaveBeenCalled();
  });

  it("scopes to the agent's saved grants", async () => {
    await (
      await load()
    )(
      new NextRequest("http://localhost/api/agents/agent-1/knowledge/folders?folder=/etc"),
      ctx as never
    );
    expect(mockGetFolderStatus).toHaveBeenCalledWith(DEFAULT_ORG_ID, "agent-1", ["/data/hr"]);
  });
});

describe("GET /api/agents/[agentId]/knowledge/files", () => {
  const request = (query: string) =>
    new NextRequest(`http://localhost/api/agents/agent-1/knowledge/files${query}`);
  const load = async () => (await import("@/app/api/agents/[agentId]/knowledge/files/route")).GET;

  it("returns 401 when unauthenticated and never lists", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await (await load())(request("?folder=/data/hr"), ctx as never);
    expect(res.status).toBe(401);
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it("answers 404 to a user the agent gate refuses, and never lists", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(notFound());
    const res = await (await load())(request("?folder=/data/hr"), ctx as never);
    expect(res.status).toBe(404);
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it("lets a member list a folder, passing the saved grants and the query", async () => {
    const res = await (
      await load()
    )(
      request("?folder=/data/hr/certs&filter=not_searchable&q=iso&offset=50&limit=25"),
      ctx as never
    );
    expect(res.status).toBe(200);
    expect(mockListFiles).toHaveBeenCalledWith(DEFAULT_ORG_ID, "agent-1", ["/data/hr"], {
      folder: "/data/hr/certs",
      filter: "not_searchable",
      q: "iso",
      offset: 50,
      limit: 25,
    });
  });

  it("requires a folder", async () => {
    const res = await (await load())(request(""), ctx as never);
    expect(res.status).toBe(400);
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  // A folder outside the grant reads exactly like one that does not exist.
  it("answers 404 for a folder the grants do not cover", async () => {
    mockListFiles.mockResolvedValueOnce(null);
    const res = await (await load())(request("?folder=/etc"), ctx as never);
    expect(res.status).toBe(404);
  });

  it("falls back to defaults for an unknown filter and non-numeric paging", async () => {
    await (
      await load()
    )(request("?folder=/data/hr&filter=evil&offset=x&limit=y"), ctx as never);
    expect(mockListFiles).toHaveBeenCalledWith(DEFAULT_ORG_ID, "agent-1", ["/data/hr"], {
      folder: "/data/hr",
      filter: "all",
      q: undefined,
      offset: 0,
      limit: 50,
    });
  });
});

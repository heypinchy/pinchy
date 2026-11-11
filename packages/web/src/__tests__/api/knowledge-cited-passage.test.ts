/**
 * Route tests for POST /api/agents/[agentId]/knowledge/passage (#1268) — the
 * citation viewer asking which passage on the cited page to highlight.
 *
 * These pin the ACCESS boundary: the endpoint returns document text, so it must
 * refuse exactly what the file route refuses, and do it before the index is
 * read. Which passage the SQL then picks is pinned against a real Postgres in
 * lib/knowledge/cited-passage.integration.test.ts.
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

const mockResolveAllowedFile = vi.fn();
vi.mock("@/lib/agent-file-access", () => ({
  resolveAllowedFile: (...args: unknown[]) => mockResolveAllowedFile(...args),
}));

const mockFindCitedPassage = vi.fn();
vi.mock("@/lib/knowledge/cited-passage", () => ({
  findCitedPassage: (...args: unknown[]) => mockFindCitedPassage(...args),
}));

const mockEmbedderAvailable = vi.fn();
vi.mock("@/lib/knowledge/kb-embedder", () => ({
  kbEmbedderAvailable: () => mockEmbedderAvailable(),
  kbEmbeddingConfig: () => ({ model: "test" }),
}));

const mockEmbedTexts = vi.fn();
vi.mock("@/lib/knowledge/embeddings", () => ({
  embedTexts: (...args: unknown[]) => mockEmbedTexts(...args),
}));

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const makeRequest = (body: unknown) =>
  new NextRequest("http://localhost/api/agents/agent-1/knowledge/passage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const agentRow = {
  id: "agent-1",
  name: "Ada",
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/quality"] } },
};

const validBody = { path: "/data/quality/Wartung.pdf", page: 4, claim: "Four hours." };

describe("POST /api/agents/[agentId]/knowledge/passage", () => {
  let POST: typeof import("@/app/api/agents/[agentId]/knowledge/passage/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    mockGetAgentWithAccess.mockResolvedValue(agentRow);
    mockResolveAllowedFile.mockResolvedValue({ ok: true, realPath: "/data/quality/Wartung.pdf" });
    mockFindCitedPassage.mockResolvedValue({ text: "Reaktionszeit vier Stunden" });
    mockEmbedderAvailable.mockReturnValue(true);
    POST = (await import("@/app/api/agents/[agentId]/knowledge/passage/route")).POST;
  });

  it("returns 401 when unauthenticated and never reads the index", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await POST(makeRequest(validBody), ctx as never);

    expect(res.status).toBe(401);
    expect(mockFindCitedPassage).not.toHaveBeenCalled();
  });

  it("answers what the agent gate answers for an agent the reader may not use", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const res = await POST(makeRequest(validBody), ctx as never);

    expect(res.status).toBe(404);
    expect(mockGetAgentWithAccess).toHaveBeenCalledWith("agent-1", "user-1", "member");
    expect(mockFindCitedPassage).not.toHaveBeenCalled();
  });

  it("rejects a body without a page", async () => {
    const res = await POST(makeRequest({ path: "/data/quality/Wartung.pdf" }), ctx as never);

    expect(res.status).toBe(400);
    expect(mockFindCitedPassage).not.toHaveBeenCalled();
  });

  it("refuses a path outside the agent's grant before reading the index", async () => {
    mockResolveAllowedFile.mockResolvedValueOnce({ ok: false, status: 403 });

    const res = await POST(makeRequest({ ...validBody, path: "/data/secret/x.pdf" }), ctx as never);

    expect(res.status).toBe(403);
    expect(mockResolveAllowedFile).toHaveBeenCalledWith("/data/secret/x.pdf", ["/data/quality"]);
    expect(mockFindCitedPassage).not.toHaveBeenCalled();
  });

  it("answers 404 for a granted path that does not exist", async () => {
    mockResolveAllowedFile.mockResolvedValueOnce({ ok: false, status: 404 });

    const res = await POST(makeRequest(validBody), ctx as never);

    expect(res.status).toBe(404);
    expect(mockFindCitedPassage).not.toHaveBeenCalled();
  });

  it("returns the passage the index picks for the page and claim", async () => {
    const res = await POST(makeRequest(validBody), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passage: { text: "Reaktionszeit vier Stunden" } });
    expect(mockFindCitedPassage).toHaveBeenCalledWith(
      DEFAULT_ORG_ID,
      ["/data/quality/Wartung.pdf"],
      4,
      "Four hours.",
      expect.objectContaining({ embed: expect.any(Function) })
    );
  });

  it("asks for the requested path and the file it resolves to", async () => {
    // A grant root may itself be a link; ingest resolves the root, so the
    // index can hold either spelling.
    mockResolveAllowedFile.mockResolvedValueOnce({
      ok: true,
      realPath: "/data/quality/real/W.pdf",
    });

    await POST(makeRequest(validBody), ctx as never);

    expect(mockFindCitedPassage.mock.calls[0][1]).toEqual([
      "/data/quality/Wartung.pdf",
      "/data/quality/real/W.pdf",
    ]);
  });

  it("looks the document up under the path the grant was checked against", async () => {
    // The grant check normalises; the index stores normalised paths. Keying
    // on the raw spelling would ask about a path nobody checked.
    await POST(
      makeRequest({ ...validBody, path: "/data/quality/./sub/../Wartung.pdf" }),
      ctx as never
    );

    expect(mockFindCitedPassage.mock.calls[0][1]).toEqual(["/data/quality/Wartung.pdf"]);
  });

  it("embeds the claim with the knowledge base's own embedder", async () => {
    mockEmbedTexts.mockResolvedValueOnce([[0.1, 0.2]]);
    await POST(makeRequest(validBody), ctx as never);

    const deps = mockFindCitedPassage.mock.calls[0][4] as {
      embed: (t: string[]) => Promise<number[][]>;
    };
    expect(await deps.embed(["Four hours."])).toEqual([[0.1, 0.2]]);
    expect(mockEmbedTexts).toHaveBeenCalledWith(["Four hours."], { model: "test" });
  });

  it("still answers without an embedder, which only matters when a page needs ranking", async () => {
    mockEmbedderAvailable.mockReturnValueOnce(false);

    const res = await POST(makeRequest(validBody), ctx as never);

    expect(res.status).toBe(200);
    expect(mockFindCitedPassage.mock.calls[0][4]).toBeNull();
  });

  it("answers null when the page has no passage to show", async () => {
    mockFindCitedPassage.mockResolvedValueOnce(null);

    const res = await POST(makeRequest(validBody), ctx as never);

    expect(await res.json()).toEqual({ passage: null });
  });

  it("answers 502 when the lookup fails, so the viewer shows the page unhighlighted", async () => {
    mockFindCitedPassage.mockRejectedValueOnce(new Error("embedding model crashed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeRequest(validBody), ctx as never);

    expect(res.status).toBe(502);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

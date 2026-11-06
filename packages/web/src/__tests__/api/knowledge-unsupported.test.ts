/**
 * Route tests for GET /api/agents/[agentId]/knowledge/unsupported (#1267) —
 * the CSV of files under the agent's folders whose type the indexer cannot
 * read.
 *
 * These cover the access boundary and the file the admin gets. Whether the
 * SQL answers for the right folders is pinned against a real Postgres in
 * lib/knowledge/unsupported-files.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import type { UnsupportedFile } from "@/lib/knowledge/unsupported-files";

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

/** The pages the mocked store yields, in order. */
let pages: UnsupportedFile[][] = [];
const mockListUnsupportedFiles = vi.fn();
vi.mock("@/lib/knowledge/unsupported-files", () => ({
  listUnsupportedFiles: (...args: unknown[]) => mockListUnsupportedFiles(...args),
}));

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const makeRequest = () =>
  new NextRequest("http://localhost/api/agents/agent-1/knowledge/unsupported");

const agentRow = {
  id: "agent-1",
  name: "Smithers",
  allowedTools: ["knowledge_search"],
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr", "/data/legal"] } },
};

const BOM = "\uFEFF";

/** The body exactly as sent. `Response.text()` would strip the BOM this file is about. */
const rawBody = async (res: Response) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());

describe("GET /api/agents/[agentId]/knowledge/unsupported", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/knowledge/unsupported/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    pages = [];
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockGetAgentWithAccess.mockResolvedValue(agentRow);
    mockListUnsupportedFiles.mockImplementation(async function* () {
      for (const page of pages) yield page;
    });
    GET = (await import("@/app/api/agents/[agentId]/knowledge/unsupported/route")).GET;
  });

  it("returns 401 when unauthenticated and never queries", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(401);
    expect(mockListUnsupportedFiles).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated non-admin and never queries", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-1", role: "member" } });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(403);
    expect(mockListUnsupportedFiles).not.toHaveBeenCalled();
  });

  it("returns 404 for an agent the caller may not see and never queries", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(404);
    expect(mockListUnsupportedFiles).not.toHaveBeenCalled();
  });

  it("asks the read gate with the caller's identity", async () => {
    await GET(makeRequest(), ctx as never);

    expect(mockGetAgentWithAccess).toHaveBeenCalledWith("agent-1", "admin-1", "admin");
  });

  // The scope comes from the agent's SAVED grants, never from the request: a
  // path in the query string would make this a way to list any folder's files.
  it("scopes the list to the agent's granted folders, ignoring the query string", async () => {
    const req = new NextRequest(
      "http://localhost/api/agents/agent-1/knowledge/unsupported?path=/etc"
    );

    await GET(req, ctx as never);

    expect(mockListUnsupportedFiles).toHaveBeenCalledWith(DEFAULT_ORG_ID, [
      "/data/hr",
      "/data/legal",
    ]);
  });

  it("scopes to nothing when the agent has no folder grants", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce({ ...agentRow, pluginConfig: null });

    await GET(makeRequest(), ctx as never);

    expect(mockListUnsupportedFiles).toHaveBeenCalledWith(DEFAULT_ORG_ID, []);
  });

  it("answers a CSV download named after the agent", async () => {
    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="smithers-unsupported-files.csv"'
    );
    // A list of a share's file names is not something a shared cache should keep.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // The BOM is what makes Excel read "Prüfbericht.tif" as UTF-8 rather than
  // as two garbled characters — the shares this is for are German-speaking.
  it("writes a BOM, a header, and one row per file across every page", async () => {
    pages = [
      [
        { sourcePath: "/data/hr/Prüfbericht.tif", type: ".tif" },
        { sourcePath: "/data/hr/README", type: "" },
      ],
      [{ sourcePath: "/data/legal/Budget, 2019.xls", type: ".xls" }],
    ];

    const res = await GET(makeRequest(), ctx as never);

    expect(await rawBody(res)).toBe(
      BOM +
        '"path","type"\n' +
        '"/data/hr/Prüfbericht.tif",".tif"\n' +
        '"/data/hr/README",""\n' +
        '"/data/legal/Budget, 2019.xls",".xls"\n'
    );
  });

  // A file name is text anybody with write access to the share chose. One
  // that starts like a formula must open as text, not run in the admin's
  // spreadsheet (lib/csv.ts).
  it("neutralizes a file name that would start a formula", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce({
      ...agentRow,
      pluginConfig: { "pinchy-files": { allowed_paths: ["=cmd"] } },
    });
    pages = [[{ sourcePath: '=HYPERLINK("http://x")', type: "" }]];

    const res = await GET(makeRequest(), ctx as never);

    expect(await res.text()).toContain(`"'=HYPERLINK(""http://x"")",""`);
  });

  // An admin who cancels a 100k-row download must not leave the route paging
  // through the rest of the table for nobody.
  it("stops paging when the download is cancelled", async () => {
    let closed = false;
    let pagesRead = 0;
    mockListUnsupportedFiles.mockImplementation(async function* () {
      try {
        for (;;) {
          pagesRead++;
          yield [{ sourcePath: `/data/hr/${pagesRead}.tif`, type: ".tif" }];
        }
      } finally {
        closed = true;
      }
    });

    const res = await GET(makeRequest(), ctx as never);
    const reader = res.body!.getReader();
    await reader.read(); // header
    await reader.read(); // first page
    await reader.cancel();

    expect(closed).toBe(true);
    expect(pagesRead).toBeLessThan(5);
  });

  it("falls back to a generic file name when the agent's name has no usable characters", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce({ ...agentRow, name: '"/\\' });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="agent-unsupported-files.csv"'
    );
  });
});

/**
 * Route tests for GET /api/agents/[agentId]/knowledge/unsearchable/csv (#1364)
 * — every document the index holds but cannot search, as a CSV download.
 *
 * These cover the access boundary and the file the admin gets. Which
 * documents the query yields, and why, is pinned against a real Postgres in
 * lib/knowledge/unsearchable.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import type { UnsearchableDocument } from "@/lib/knowledge/unsearchable";

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

/** The pages the mocked query yields, in order. */
let pages: UnsearchableDocument[][] = [];
const mockUnsearchableDocumentPages = vi.fn();
vi.mock("@/lib/knowledge/unsearchable", () => ({
  unsearchableDocumentPages: (...args: unknown[]) => mockUnsearchableDocumentPages(...args),
}));

const OCR_OFF = { state: "off" } as const;
const mockKbOcrAvailability = vi.fn();
vi.mock("@/lib/knowledge/kb-ocr", () => ({
  kbOcrAvailability: (...args: unknown[]) => mockKbOcrAvailability(...args),
}));

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const makeRequest = (query = "") =>
  new NextRequest(`http://localhost/api/agents/agent-1/knowledge/unsearchable/csv${query}`);

const agentRow = {
  id: "agent-1",
  name: "Smithers",
  allowedTools: ["knowledge_search"],
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr", "/data/legal"] } },
};

const doc = (overrides: Partial<UnsearchableDocument>): UnsearchableDocument => ({
  sourcePath: "/data/hr/Scan.pdf",
  name: "Scan.pdf",
  root: "/data/hr",
  folder: "",
  status: "active",
  reason: "no_text",
  cause: "ocr_off",
  ...overrides,
});

const BOM = "﻿";

/** The body exactly as sent. `Response.text()` would strip the BOM. */
const rawBody = async (res: Response) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());

describe("GET /api/agents/[agentId]/knowledge/unsearchable/csv", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/knowledge/unsearchable/csv/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    pages = [];
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockGetAgentWithAccess.mockResolvedValue(agentRow);
    mockKbOcrAvailability.mockResolvedValue(OCR_OFF);
    mockUnsearchableDocumentPages.mockImplementation(async function* () {
      for (const page of pages) yield page;
    });
    GET = (await import("@/app/api/agents/[agentId]/knowledge/unsearchable/csv/route")).GET;
  });

  it("returns 401 when unauthenticated and never queries", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(401);
    expect(mockUnsearchableDocumentPages).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated non-admin and never queries", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-1", role: "member" } });

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(403);
    expect(mockUnsearchableDocumentPages).not.toHaveBeenCalled();
  });

  it("returns 404 for an agent the caller may not see and never queries", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(404);
    expect(mockUnsearchableDocumentPages).not.toHaveBeenCalled();
  });

  it("asks the read gate with the caller's identity", async () => {
    await GET(makeRequest(), ctx as never);

    expect(mockGetAgentWithAccess).toHaveBeenCalledWith("agent-1", "admin-1", "admin");
  });

  // The scope comes from the agent's SAVED grants, never from the request.
  it("scopes the list to the agent's grants and the server's OCR setup, ignoring the query string", async () => {
    await GET(makeRequest("?path=%2Fetc&root=%2Fetc"), ctx as never);

    expect(mockUnsearchableDocumentPages).toHaveBeenCalledWith(
      DEFAULT_ORG_ID,
      ["/data/hr", "/data/legal"],
      OCR_OFF
    );
  });

  it("scopes to nothing when the agent has no folder grants", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce({ ...agentRow, pluginConfig: null });

    await GET(makeRequest(), ctx as never);

    expect(mockUnsearchableDocumentPages).toHaveBeenCalledWith(DEFAULT_ORG_ID, [], OCR_OFF);
  });

  it("answers a CSV download named after the agent", async () => {
    const res = await GET(makeRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="smithers-unsearchable-documents.csv"'
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // The reason column says why in words, the same words the page uses, so a
  // spreadsheet filtered on it reads without a legend.
  it("writes a BOM, a header, and one row per document across every page", async () => {
    pages = [
      [
        doc({
          sourcePath: "/data/hr/Zertifikate/Prüfbericht.pdf",
          name: "Prüfbericht.pdf",
          folder: "Zertifikate",
        }),
        doc({
          sourcePath: "/data/hr/OLD/Blank.pdf",
          name: "Blank.pdf",
          folder: "OLD",
          status: "archived",
          cause: "read_blank",
        }),
      ],
      [
        doc({
          sourcePath: "/data/legal/Vertrag.docx",
          name: "Vertrag.docx",
          root: "/data/legal",
          reason: "awaiting_conversion",
          cause: null,
        }),
        doc({
          sourcePath: "/data/legal/A.pdf",
          name: "A.pdf",
          root: "/data/legal",
          cause: "no_vision_model",
        }),
        doc({
          sourcePath: "/data/legal/B.pdf",
          name: "B.pdf",
          root: "/data/legal",
          cause: "read_next_run",
        }),
      ],
    ];

    const res = await GET(makeRequest(), ctx as never);

    expect(await rawBody(res)).toBe(
      BOM +
        '"name","folder","reason","status","path"\n' +
        '"Prüfbericht.pdf","hr/Zertifikate","No text layer; reading scans is switched off on this server","active","/data/hr/Zertifikate/Prüfbericht.pdf"\n' +
        '"Blank.pdf","hr/OLD","Read in full; no text found","archived","/data/hr/OLD/Blank.pdf"\n' +
        '"Vertrag.docx","legal","Waiting to be converted again","active","/data/legal/Vertrag.docx"\n' +
        '"A.pdf","legal","No text layer; no vision model is available to read it","active","/data/legal/A.pdf"\n' +
        '"B.pdf","legal","No text layer; the next run reads it with a vision model","active","/data/legal/B.pdf"\n'
    );
  });

  // A file name is text anybody with write access to the share chose. One
  // that starts like a formula must open as text, not run in the admin's
  // spreadsheet (lib/csv.ts).
  it("neutralizes a file name or folder that would start a formula", async () => {
    pages = [
      [
        doc({
          sourcePath: '/data/hr/=cmd/=HYPERLINK("http://x")',
          name: '=HYPERLINK("http://x")',
          folder: "=cmd",
        }),
      ],
    ];

    const body = await (await GET(makeRequest(), ctx as never)).text();

    expect(body).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(body).not.toMatch(/(^|,)"=/m);
  });

  // An admin who cancels a 100k-row download must not leave the route paging
  // through the rest of the table for nobody.
  it("stops paging when the download is cancelled", async () => {
    let closed = false;
    let pagesRead = 0;
    mockUnsearchableDocumentPages.mockImplementation(async function* () {
      try {
        for (;;) {
          pagesRead++;
          yield [doc({ sourcePath: `/data/hr/${pagesRead}.pdf`, name: `${pagesRead}.pdf` })];
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
      'attachment; filename="agent-unsearchable-documents.csv"'
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- mocks ---------------------------------------------------------------
vi.mock("@/lib/gateway-auth", () => ({ validateGatewayToken: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/db", () => ({ db: { select: vi.fn() } }));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { POST, GET } from "../route";

const mockValidate = vi.mocked(validateGatewayToken);
const mockDb = vi.mocked(db);

const REAL_TOKEN = "ghp_real_secret_token";
const GATEWAY_TOKEN = "gw-bootstrap-token";

type ConnRow = {
  id: string;
  type: string;
  status: string;
  credentials: string;
  data: Record<string, unknown> | null;
};

function makeConn(overrides: Partial<ConnRow> = {}): ConnRow {
  return {
    id: "conn-1",
    type: "mcp",
    status: "active",
    // decrypt is identity in tests, so credentials is plain JSON here
    credentials: JSON.stringify({ token: REAL_TOKEN }),
    data: { url: "https://api.githubcopilot.com/mcp/", transport: "http" },
    ...overrides,
  };
}

function setConn(row: ConnRow | null) {
  mockDb.select.mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(row ? [row] : []),
          }),
        }),
      }) as never
  );
}

function makeRequest(
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://pinchy:7777/api/internal/mcp-proxy/conn-1", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ connectionId: "conn-1" });

function upstreamResponse(
  bodyObj: unknown = { jsonrpc: "2.0", id: 1, result: { tools: [] } },
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(bodyObj), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidate.mockReturnValue(true);
  setConn(makeConn());
  global.fetch = vi.fn().mockResolvedValue(upstreamResponse());
});

describe("MCP credential proxy route", () => {
  it("rejects requests without a valid gateway token (401, no DB/fetch)", async () => {
    mockValidate.mockReturnValue(false);
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(401);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown connection", async () => {
    setConn(null);
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-mcp connection", async () => {
    setConn(makeConn({ type: "odoo" }));
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 403 for a pending connection", async () => {
    setConn(makeConn({ status: "pending" }));
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks an upstream URL that targets a private/internal address (SSRF, no fetch)", async () => {
    setConn(
      makeConn({ data: { url: "http://169.254.169.254/latest/meta-data/", transport: "http" } })
    );
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(502);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards to the upstream URL with the REAL token injected (never the gateway token)", async () => {
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/mcp/");
    expect(init.method).toBe("POST");
    const sentAuth = new Headers(init.headers).get("authorization");
    expect(sentAuth).toBe(`Bearer ${REAL_TOKEN}`);
    expect(sentAuth).not.toContain(GATEWAY_TOKEN);
  });

  it("never leaks the real token in a decrypt-failure error body", async () => {
    setConn(makeConn({ credentials: "not-json{" }));
    // decrypt is identity → JSON.parse fails
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(REAL_TOKEN);
  });

  it("injects the connection's non-secret extraHeaders alongside auth", async () => {
    setConn(
      makeConn({
        data: {
          url: "https://services.leadconnectorhq.com/mcp/",
          transport: "http",
          extraHeaders: { locationId: "loc-123" },
        },
      })
    );
    await POST(makeRequest(), { params });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers(init.headers).get("locationId")).toBe("loc-123");
  });

  it("forwards Mcp-Session-Id in both directions", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      upstreamResponse(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "sess-xyz" } }
      )
    );
    const res = await POST(makeRequest(undefined, { "mcp-session-id": "sess-abc" }), { params });
    // request → upstream
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers(init.headers).get("mcp-session-id")).toBe("sess-abc");
    // upstream → response
    expect(res.headers.get("mcp-session-id")).toBe("sess-xyz");
  });

  it("supports GET (SSE stream open) through the same proxy", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("data: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
    const getReq = new NextRequest("http://pinchy:7777/api/internal/mcp-proxy/conn-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
    });
    const res = await GET(getReq, { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/mcp/");
    expect(init.method).toBe("GET");
  });

  // --- Task 2: streaming / abort correctness -----------------------------
  it("streams the upstream body back WITHOUT buffering it (no .text()/.json())", async () => {
    const upstream = upstreamResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(upstream);
    const res = await POST(makeRequest(), { params });
    // If the route had buffered (.text()/.json()), the upstream body would be consumed.
    expect(upstream.bodyUsed).toBe(false);
    expect(res.body).not.toBeNull();
  });

  it("wires the request abort signal into the upstream fetch", async () => {
    await POST(makeRequest(), { params });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an upstream redirect instead of following it (no proxy bypass / SSRF)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
    );
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(502);
  });
});

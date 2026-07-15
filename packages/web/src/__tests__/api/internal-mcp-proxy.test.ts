import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/lib/encryption", () => ({
  // decrypt is identity in tests, so `credentials` below is plain JSON.
  decrypt: (v: string) => v,
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { POST, GET } from "@/app/api/internal/mcp-proxy/[connectionId]/route";

const mockValidate = vi.mocked(validateGatewayToken);

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
    credentials: JSON.stringify({ token: REAL_TOKEN }),
    data: { url: "https://api.githubcopilot.com/mcp/", transport: "http" },
    ...overrides,
  };
}

function mockDbSelectResult(row: ConnRow | null) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as any);
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
  vi.stubEnv("PINCHY_MCP_ENABLED", "1");
  mockValidate.mockReturnValue(true);
  mockDbSelectResult(makeConn());
  global.fetch = vi.fn().mockResolvedValue(upstreamResponse());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MCP credential proxy route", () => {
  it("rejects requests without a valid gateway token (401, no DB/fetch)", async () => {
    mockValidate.mockReturnValue(false);
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 404 when PINCHY_MCP_ENABLED is not set, before touching the DB (kill switch)", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", undefined);
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect(db.select).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns an actionable Gone-Contract 404 for an unknown connection", async () => {
    mockDbSelectResult(null);
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
    const body = await res.json();
    // Mirrors .../internal/integrations/[connectionId]/credentials/route.ts:
    // the plugins surface body.error into the agent's tool error, so a bare
    // "Connection not found" reaches the user as an opaque "technical
    // problem (error 404)".
    expect(body.error).toMatch(/no longer connected/i);
    expect(body.error).toMatch(/integrations/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns a terse 404 for a non-mcp connection, distinct from the Gone-Contract wording", async () => {
    mockDbSelectResult(makeConn({ type: "odoo" }));
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
    const body = await res.json();
    // This is a config/programming error (a connectionId that exists but
    // isn't MCP), not a user-facing "reconnect it" situation — must not
    // reuse the Gone-Contract message above.
    expect(body.error).not.toMatch(/no longer connected/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 403 for a pending connection", async () => {
    mockDbSelectResult(makeConn({ status: "pending" }));
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks an upstream URL that targets a private/internal address (SSRF, no fetch)", async () => {
    mockDbSelectResult(
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
    const [url, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/mcp/");
    expect((init as RequestInit).method).toBe("POST");
    const sentAuth = new Headers((init as RequestInit).headers).get("authorization");
    expect(sentAuth).toBe(`Bearer ${REAL_TOKEN}`);
    expect(sentAuth).not.toContain(GATEWAY_TOKEN);
  });

  it("never leaks the real token in a decrypt-failure error body", async () => {
    mockDbSelectResult(makeConn({ credentials: "not-json{" }));
    // decrypt is identity → JSON.parse fails
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(REAL_TOKEN);
  });

  it("injects the connection's non-secret extraHeaders alongside auth", async () => {
    mockDbSelectResult(
      makeConn({
        data: {
          url: "https://services.leadconnectorhq.com/mcp/",
          transport: "http",
          extraHeaders: { locationId: "loc-123" },
        },
      })
    );
    await POST(makeRequest(), { params });
    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("locationId")).toBe("loc-123");
  });

  it("never lets extraHeaders override Authorization — the real token still goes out", async () => {
    mockDbSelectResult(
      makeConn({
        data: {
          url: "https://api.githubcopilot.com/mcp/",
          transport: "http",
          extraHeaders: {
            Authorization: "Bearer attacker-supplied-value",
            "Content-Type": "text/plain",
            Accept: "text/plain",
          },
        },
      })
    );
    await POST(makeRequest(), { params });
    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const sentHeaders = new Headers((init as RequestInit).headers);
    expect(sentHeaders.get("authorization")).toBe(`Bearer ${REAL_TOKEN}`);
    expect(sentHeaders.get("content-type")).not.toBe("text/plain");
    expect(sentHeaders.get("accept")).not.toBe("text/plain");
  });

  it("forwards Mcp-Session-Id in both directions", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      upstreamResponse(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "sess-xyz" } }
      )
    );
    const res = await POST(makeRequest(undefined, { "mcp-session-id": "sess-abc" }), { params });
    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("mcp-session-id")).toBe("sess-abc");
    expect(res.headers.get("mcp-session-id")).toBe("sess-xyz");
  });

  it("supports GET (SSE stream open) through the same proxy", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
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
    const [url, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/mcp/");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("streams the upstream body back WITHOUT buffering it (no .text()/.json())", async () => {
    const upstream = upstreamResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    vi.mocked(global.fetch).mockResolvedValue(upstream);
    const res = await POST(makeRequest(), { params });
    expect(upstream.bodyUsed).toBe(false);
    expect(res.body).not.toBeNull();
  });

  it("wires the request abort signal into the upstream fetch", async () => {
    await POST(makeRequest(), { params });
    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("returns 499 when the upstream fetch aborts (client disconnected — nothing to return)", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    vi.mocked(global.fetch).mockRejectedValue(abortError);
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(499);
  });

  it("rejects an upstream redirect instead of following it (no proxy bypass / SSRF)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
    );
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(502);
  });

  it("strips hop-by-hop response headers before returning them", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          connection: "keep-alive",
        },
      })
    );
    const res = await POST(makeRequest(), { params });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
  });
});

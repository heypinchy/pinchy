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

// The SSRF guard resolves the upstream host. No test here may touch real DNS:
// every name resolves to one public address by default.
const PUBLIC_ANSWER = "93.184.216.34";
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ default: { lookup: mockLookup }, lookup: mockLookup }));

// The upstream request goes through `pinnedFetch` (real sockets, covered in
// pinned-connection.test.ts). Here it hands the request to the mocked global
// fetch, so the existing assertions keep reading it there, and the spy records
// which addresses each request was pinned to.
const { mockPinnedFetch } = vi.hoisted(() => ({ mockPinnedFetch: vi.fn() }));
vi.mock("@/lib/pinned-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pinned-connection")>()),
  pinnedFetch: mockPinnedFetch,
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
    data: {
      url: "https://api.githubcopilot.com/mcp/",
      transport: "http",
      tools: [{ name: "create_issue" }, { name: "list_repos" }],
    },
    ...overrides,
  };
}

// The grants a live agent holds on the connection, as the route's second
// query answers them (the DB has already joined live agents and filtered to
// MCP rows for this connection).
let grantRows: Array<{ operation: string }> = [];
const grantWhere = vi.fn();

function mockDbSelectResult(row: ConnRow | null) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: vi.fn().mockReturnValue({
          // connection lookup
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(row ? [row] : []),
          }),
          // grant lookup
          innerJoin: vi.fn().mockReturnValue({
            where: grantWhere.mockImplementation(() => Promise.resolve(grantRows)),
          }),
        }),
      }) as any
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
  vi.stubEnv("PINCHY_MCP_ENABLED", "1");
  mockValidate.mockReturnValue(true);
  grantRows = [{ operation: "create_issue" }];
  mockDbSelectResult(makeConn());
  global.fetch = vi.fn().mockResolvedValue(upstreamResponse());
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: PUBLIC_ANSWER, family: 4 }]);
  mockPinnedFetch.mockReset();
  mockPinnedFetch.mockImplementation((url: string, init: RequestInit) => global.fetch(url, init));
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

  it("returns 403 for an auth_failed connection — build.ts emits no server for it, so nothing legitimate calls", async () => {
    mockDbSelectResult(makeConn({ status: "auth_failed" }));
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 403 when no live agent holds a grant on a tool the connection still has", async () => {
    // build.ts emits mcp.servers only for a connection with at least one
    // surviving grant. A connection without one has no business reaching its
    // upstream with the stored token, whoever holds the gateway token.
    grantRows = [];
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("counts only grants on tools still in the synced list (drift), like build.ts", async () => {
    grantRows = [{ operation: "tool_removed_by_resync" }];
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe("tools/call is limited to granted tools", () => {
    // build.ts advertises only granted tools to each agent (tools.allow), but
    // that filter lives in OpenClaw. The upstream token reaches this proxy
    // for the whole connection, so a call for an ungranted tool on the same
    // server must stop here too — not only in the model's tool list.
    const call = (name: string, id: number | string = 7) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: {} },
    });

    it("forwards a call for a tool a live agent is granted", async () => {
      const res = await POST(makeRequest(call("create_issue")), { params });
      expect(res.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("answers a call for an ungranted tool with a JSON-RPC error and never forwards it", async () => {
      const res = await POST(makeRequest(call("list_repos", "req-9")), { params });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: "req-9",
        error: { code: -32602 },
      });
      expect(body.error.message).toContain("list_repos");
    });

    it("rejects a call for a tool that only a drifted grant names", async () => {
      // legacy_search was granted, then removed upstream by a re-sync; the
      // row survives but the tool is no longer in data.tools.
      grantRows = [{ operation: "create_issue" }, { operation: "legacy_search" }];
      const res = await POST(makeRequest(call("legacy_search")), { params });
      expect(global.fetch).not.toHaveBeenCalled();
      expect((await res.json()).error.code).toBe(-32602);
    });

    it("passes protocol traffic other than tools/call through", async () => {
      const res = await POST(
        makeRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        { params }
      );
      expect(res.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects a batch that smuggles an ungranted call next to a granted one", async () => {
      const res = await POST(makeRequest([call("create_issue", 1), call("list_repos", 2)]), {
        params,
      });
      expect(res.status).toBe(403);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("rejects a call without a tool name", async () => {
      const res = await POST(
        makeRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }),
        { params }
      );
      expect(global.fetch).not.toHaveBeenCalled();
      expect((await res.json()).error.code).toBe(-32602);
    });

    it("rejects a POST body that is not JSON instead of forwarding it unread", async () => {
      const req = new NextRequest("http://pinchy:7777/api/internal/mcp-proxy/conn-1", {
        method: "POST",
        headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","method":"tools/call"',
      });
      const res = await POST(req, { params });
      expect(res.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  it("blocks an upstream URL that targets a private/internal address (SSRF, no fetch)", async () => {
    mockDbSelectResult(
      makeConn({
        data: {
          url: "http://169.254.169.254/latest/meta-data/",
          transport: "http",
          tools: [{ name: "create_issue" }],
        },
      })
    );
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(502);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("connects to the address the SSRF guard classified, never resolving the host again (DNS rebinding)", async () => {
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);
    // One lookup — the guard's. The connection is pinned to its answer, so a
    // resolver that answers a public address for the check and 127.0.0.1 for
    // the connect gets no second chance to answer.
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockPinnedFetch).toHaveBeenCalledTimes(1);
    const [url, init, target] = mockPinnedFetch.mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/mcp/");
    expect(init).toMatchObject({ redirect: "manual" });
    expect(target).toEqual([{ address: PUBLIC_ANSWER, family: 4 }]);
  });

  it("refuses an upstream host that resolves to a private address, without connecting", async () => {
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(502);
    expect(mockPinnedFetch).not.toHaveBeenCalled();
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
          tools: [{ name: "create_issue" }],
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
          tools: [{ name: "create_issue" }],
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

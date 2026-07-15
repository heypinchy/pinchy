import { describe, it, expect } from "vitest";
import {
  buildNativeMcp,
  mcpProxyUrl,
  mcpServerKey,
  nativeMcpToolName,
} from "@/lib/openclaw-config/native-mcp";

describe("mcpServerKey", () => {
  it("produces a safe, letter-initial, ≤30-char key (OpenClaw sanitizer identity)", () => {
    // Short test ids: dashes stripped, "m" prefix.
    expect(mcpServerKey("gh-1")).toBe("mgh1");
    expect(mcpServerKey("conn-abc")).toBe("mconnabc");
  });

  it("keeps a 36-char UUID within OpenClaw's 30-char server-name budget", () => {
    const key = mcpServerKey("7bbfbc51-68f2-4122-882c-76ce6eff64cd");
    expect(key.length).toBeLessThanOrEqual(30);
    expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/); // letter-initial, safe charset
    expect(key.startsWith("m")).toBe(true);
  });
});

describe("nativeMcpToolName", () => {
  it("namespaces a tool as <serverKey>__<tool>", () => {
    expect(nativeMcpToolName("gh-1", "pull_request_read")).toBe("mgh1__pull_request_read");
  });
});

describe("mcpProxyUrl", () => {
  it("builds the Pinchy proxy URL for a connection (trims trailing slash on base)", () => {
    expect(mcpProxyUrl("http://pinchy:7777", "conn-abc")).toBe(
      "http://pinchy:7777/api/internal/mcp-proxy/conn-abc"
    );
    expect(mcpProxyUrl("http://pinchy:7777/", "conn-abc")).toBe(
      "http://pinchy:7777/api/internal/mcp-proxy/conn-abc"
    );
  });
});

describe("buildNativeMcp", () => {
  const opts = { proxyBaseUrl: "http://pinchy:7777", gatewayToken: "gw-bootstrap-token" };
  const conns = [
    {
      id: "gh-1",
      transport: "http" as const,
      agentTools: { "agent-a": ["pull_request_read", "list_pull_requests"] },
    },
    {
      id: "ghl-1",
      transport: "sse" as const,
      agentTools: { "agent-a": ["contacts_get"], "agent-b": ["contacts_get"] },
    },
  ];

  const out = buildNativeMcp(conns, opts);

  it("keys servers by the sanitized server key, NOT the raw connectionId", () => {
    expect(out.servers["mgh1"]).toBeDefined();
    expect(out.servers["gh-1"]).toBeUndefined();
  });

  it("points every server at the Pinchy proxy (with the raw connectionId), NOT the third-party server", () => {
    expect(out.servers["mgh1"].url).toBe("http://pinchy:7777/api/internal/mcp-proxy/gh-1");
    expect(out.servers["mghl1"].url).toBe("http://pinchy:7777/api/internal/mcp-proxy/ghl-1");
  });

  it("normalizes transport (http → streamable-http), preserves sse", () => {
    expect(out.servers["mgh1"].transport).toBe("streamable-http");
    expect(out.servers["mghl1"].transport).toBe("sse");
  });

  it("emits ONLY the gateway token in headers — no third-party credential, no env template", () => {
    expect(out.servers["mgh1"].headers.Authorization).toBe("Bearer gw-bootstrap-token");
    expect(out.servers["mgh1"].headers.Authorization).not.toContain("${");
    expect(Object.keys(out.servers["mgh1"].headers)).toEqual(["Authorization"]);
  });

  it("builds per-agent tools.allow as the materialized <serverKey>__<tool> name", () => {
    expect(out.toolAllowByAgent["agent-a"].sort()).toEqual(
      ["mgh1__list_pull_requests", "mgh1__pull_request_read", "mghl1__contacts_get"].sort()
    );
    expect(out.toolAllowByAgent["agent-b"]).toEqual(["mghl1__contacts_get"]);
  });

  it("returns empty structures for no connections", () => {
    expect(buildNativeMcp([], opts)).toEqual({ servers: {}, toolAllowByAgent: {} });
  });

  it("throws loudly on a server-key collision instead of silently mis-gating tools", () => {
    // Two distinct connectionIds that sanitize to the SAME mcpServerKey (only
    // alphanumerics survive the sanitizer, and the key is truncated to 30
    // chars) — e.g. one id carrying extra punctuation that another doesn't.
    // Per the module doc comment: a silent collision would let one
    // connection's proxy URL and headers overwrite another's, while
    // tools.allow entries for BOTH connections would resolve against
    // whichever server happened to win the object-key write — a fail-open
    // authorization mix-up. buildNativeMcp must fail loudly instead.
    const collidingConns = [
      { id: "conn-abc", transport: "http" as const, agentTools: { "agent-a": ["tool_one"] } },
      { id: "conn--abc", transport: "http" as const, agentTools: { "agent-b": ["tool_two"] } },
    ];
    expect(mcpServerKey("conn-abc")).toBe(mcpServerKey("conn--abc")); // sanity: same key
    expect(() => buildNativeMcp(collidingConns, opts)).toThrow(/Duplicate MCP server key/);
  });
});

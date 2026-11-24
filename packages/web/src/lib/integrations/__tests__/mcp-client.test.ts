import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpMockServer } from "@/test-utils/mcp-mock-server";
import { createMcpMockServer } from "@/test-utils/mcp-mock-server";
import { toPinnedTarget } from "@/lib/pinned-connection";
import {
  listMcpTools,
  mcpErrorCodeFromError,
  originPinnedFetch,
  McpAuthError,
  McpServerError,
  McpSchemaError,
} from "../mcp-client";

// The SSRF guard always refuses loopback (ALLOW_PRIVATE_URLS opens only the
// private class), and the mock server listens on 127.0.0.1. So the guard is a
// seam here that passes by default and pins every URL to 127.0.0.1; its own
// decisions are covered in url-validation.test.ts, and the tests at the bottom
// pin that listMcpTools really consults it — and awaits it — before any
// network activity, and then connects to the addresses it classified.
const mockResolveExternalUrlTarget = vi.fn();
vi.mock("../url-validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../url-validation")>();
  return {
    ...actual,
    resolveExternalUrlTarget: (...args: Parameters<typeof actual.resolveExternalUrlTarget>) =>
      mockResolveExternalUrlTarget(...args),
  };
});

// Wrapped, not replaced: the real agent still connects. The spy only lets a
// test see whether a connection was ever set up.
const { createPinnedAgentSpy } = vi.hoisted(() => ({ createPinnedAgentSpy: vi.fn() }));
vi.mock("@/lib/pinned-connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pinned-connection")>();
  createPinnedAgentSpy.mockImplementation(actual.createPinnedAgent);
  return { ...actual, createPinnedAgent: createPinnedAgentSpy };
});

function pinnedToLoopback(url: string) {
  return { valid: true, url: new URL(url).origin, target: toPinnedTarget(["127.0.0.1"]) };
}

describe("listMcpTools", () => {
  let mock: McpMockServer | undefined;

  beforeEach(() => {
    mockResolveExternalUrlTarget.mockReset();
    mockResolveExternalUrlTarget.mockImplementation(async (url: string) => pinnedToLoopback(url));
    createPinnedAgentSpy.mockClear();
  });

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = undefined;
    }
  });

  describe("HTTP transport", () => {
    it("returns tools on success", async () => {
      mock = await createMcpMockServer("normal");
      const tools = await listMcpTools({
        url: `http://127.0.0.1:${mock.port}/mcp`,
        transport: "http",
        token: "test-token",
      });

      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({
        name: "get_weather",
        description: "Get the current weather for a location",
        inputSchema: expect.objectContaining({ type: "object" }),
      });
      expect(tools[1]).toMatchObject({
        name: "search_web",
        description: "Search the web",
        inputSchema: expect.objectContaining({ type: "object" }),
      });
    });

    it("throws McpAuthError on 401", async () => {
      mock = await createMcpMockServer("auth-error");
      await expect(
        listMcpTools({
          url: `http://127.0.0.1:${mock.port}/mcp`,
          transport: "http",
          token: "bad-token",
        })
      ).rejects.toThrow(McpAuthError);
    });

    it("throws McpAuthError on 403 (authenticated but missing scope — still the token's fault)", async () => {
      // Regression guard: a 403 used to fall through the status checks, fail
      // later on the tools/list shape check as an McpSchemaError, and get
      // classified transient — so we told the user "couldn't reach the server,
      // try again" while the server was perfectly reachable and the token was
      // the actual problem. 403 must reach the auth path like main's microsoft
      // probe branch (401 || 403).
      mock = await createMcpMockServer("forbidden");
      await expect(
        listMcpTools({
          url: `http://127.0.0.1:${mock.port}/mcp`,
          transport: "http",
          token: "under-scoped-token",
        })
      ).rejects.toThrow(McpAuthError);
    });

    it("throws McpServerError on 5xx with body", async () => {
      mock = await createMcpMockServer("server-error");
      const err = await listMcpTools({
        url: `http://127.0.0.1:${mock.port}/mcp`,
        transport: "http",
        token: "test-token",
      }).catch((e) => e);

      expect(err).toBeInstanceOf(McpServerError);
      expect((err as McpServerError).statusCode).toBe(500);
      expect((err as McpServerError).body).toContain("Internal Server Error");
    });

    it("throws McpSchemaError when a tool is missing `name`", async () => {
      mock = await createMcpMockServer("malformed");
      await expect(
        listMcpTools({
          url: `http://127.0.0.1:${mock.port}/mcp`,
          transport: "http",
          token: "test-token",
        })
      ).rejects.toThrow(McpSchemaError);
    });

    it("throws on timeout", async () => {
      mock = await createMcpMockServer("hang");
      await expect(
        listMcpTools(
          {
            url: `http://127.0.0.1:${mock.port}/mcp`,
            transport: "http",
            token: "test-token",
          },
          undefined,
          100 // override timeout to 100ms in tests instead of 10s
        )
      ).rejects.toThrow("abort");
    }, 3000); // vitest test timeout: 3s is plenty for a 100ms abort
  });

  // The SSE transport goes through the MCP SDK rather than our own fetch, so
  // its auth failures arrive as the SDK's SseError (which carries the HTTP
  // status on `.code`) and must be translated back onto our typed errors.
  // These run against the real SDK transport — mocking it would prove nothing
  // about the shape the SDK actually throws.
  describe("SSE transport", () => {
    it("translates a 401 from the SDK transport into McpAuthError", async () => {
      mock = await createMcpMockServer("auth-error");
      await expect(
        listMcpTools({
          url: `http://127.0.0.1:${mock.port}/sse`,
          transport: "sse",
          token: "bad-token",
        })
      ).rejects.toThrow(McpAuthError);
    }, 10000);

    it("translates a 403 from the SDK transport into McpAuthError", async () => {
      mock = await createMcpMockServer("forbidden");
      await expect(
        listMcpTools({
          url: `http://127.0.0.1:${mock.port}/sse`,
          transport: "sse",
          token: "under-scoped-token",
        })
      ).rejects.toThrow(McpAuthError);
    }, 10000);
  });

  describe("SSRF guard", () => {
    it("refuses a loopback URL through the real (async) guard before connecting", async () => {
      // The guard resolves DNS and is async. A synchronous call reads
      // `.valid` off a Promise — so this pins that the refusal really comes
      // from the guard's verdict, with its message, and no connection is set up.
      const actual = await vi.importActual<typeof import("../url-validation")>("../url-validation");
      mockResolveExternalUrlTarget.mockImplementation(actual.resolveExternalUrlTarget);
      await expect(
        listMcpTools({ url: "http://127.0.0.1:9/mcp", transport: "http", token: "t" })
      ).rejects.toThrow(/Invalid MCP server URL: Blocked/);
      expect(mockResolveExternalUrlTarget).toHaveBeenCalledWith("http://127.0.0.1:9/mcp");
      expect(createPinnedAgentSpy).not.toHaveBeenCalled();
    });

    it("connects once the guard's verdict resolves to valid", async () => {
      mockResolveExternalUrlTarget.mockImplementation(
        (url: string) =>
          new Promise((resolve) => setTimeout(() => resolve(pinnedToLoopback(url)), 5))
      );
      mock = await createMcpMockServer("normal");
      const tools = await listMcpTools({
        url: `http://127.0.0.1:${mock.port}/mcp`,
        transport: "http",
        token: "test-token",
      });
      expect(tools).toHaveLength(2);
    });
  });

  // DNS rebinding: the guard classifies the addresses a name resolves to, and
  // whoever connects next must use exactly those — a second lookup can answer
  // differently (a public address for the check, 127.0.0.1 for the connect).
  // `.invalid` never resolves (RFC 6761), so a request that looked the name up
  // again could not succeed; reaching the mock proves the connection went to
  // the address the guard handed over.
  describe("address pinning", () => {
    it("HTTP: connects to the guard's addresses instead of resolving the name again", async () => {
      mock = await createMcpMockServer("normal");
      const tools = await listMcpTools({
        url: `http://mcp-upstream.invalid:${mock.port}/mcp`,
        transport: "http",
        token: "test-token",
      });
      expect(tools).toHaveLength(2);
    });

    it("SSE: connects to the guard's addresses instead of resolving the name again", async () => {
      mock = await createMcpMockServer("auth-error");
      // A 401 is an answer from the mock — reaching it at all is the point.
      await expect(
        listMcpTools({
          url: `http://mcp-upstream.invalid:${mock.port}/sse`,
          transport: "sse",
          token: "bad-token",
        })
      ).rejects.toThrow(McpAuthError);
    }, 10000);
  });

  describe("originPinnedFetch", () => {
    // The pinned agent answers EVERY name with the checked addresses, and an
    // address literal needs no lookup at all, so a request to another origin
    // would either borrow the pin or skip it. Neither was checked.
    it("refuses a request to an origin other than the one that was checked", async () => {
      const pinned = originPinnedFetch("https://mcp.example.com", toPinnedTarget(["203.0.113.7"]));
      try {
        await expect(pinned.fetch("http://169.254.169.254/latest", {})).rejects.toThrow(/origin/i);
        await expect(pinned.fetch("https://other.example.com/mcp", {})).rejects.toThrow(/origin/i);
      } finally {
        await pinned.close();
      }
    });
  });
});

describe("mcpErrorCodeFromError", () => {
  // The API routes ship this code to the browser so the dialog can render a
  // human-friendly message (mcp-error-messages.ts) instead of leaking a raw
  // protocol error like "MCP server returned 503: boom" at users.
  it("maps the typed client errors onto stable wire codes", () => {
    expect(mcpErrorCodeFromError(new McpAuthError())).toBe("unauthorized");
    expect(mcpErrorCodeFromError(new McpServerError(503, "boom"))).toBe("server_error");
    expect(mcpErrorCodeFromError(new McpSchemaError("tool missing name"))).toBe("schema");
  });

  it("treats everything else (timeouts, DNS, refused) as a network failure", () => {
    expect(mcpErrorCodeFromError(new Error("This operation was aborted"))).toBe("network");
    expect(mcpErrorCodeFromError("not even an Error")).toBe("network");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpMockServer } from "@/test-utils/mcp-mock-server";
import { createMcpMockServer } from "@/test-utils/mcp-mock-server";
import {
  listMcpTools,
  mcpErrorCodeFromError,
  McpAuthError,
  McpServerError,
  McpSchemaError,
} from "../mcp-client";

describe("listMcpTools", () => {
  let mock: McpMockServer;

  beforeEach(() => {
    // Allow loopback URLs so the mock server (127.0.0.1) passes SSRF validation
    vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (mock) {
      await mock.close();
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

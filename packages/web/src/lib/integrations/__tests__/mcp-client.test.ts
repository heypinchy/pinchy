import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { McpMockServer } from "@/test-utils/mcp-mock-server";
import { createMcpMockServer } from "@/test-utils/mcp-mock-server";
import { listMcpTools, McpAuthError, McpServerError, McpSchemaError } from "../mcp-client";

describe("listMcpTools", () => {
  let mock: McpMockServer;

  afterEach(async () => {
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
      ).rejects.toThrow();
    }, 3000); // vitest test timeout: 3s is plenty for a 100ms abort
  });
});

import { describe, expect, it } from "vitest";
import type { IntegrationData, McpIntegrationData } from "../types";

describe("IntegrationData (MCP variant)", () => {
  it("accepts a well-formed MCP payload", () => {
    const value: McpIntegrationData = {
      type: "mcp",
      preset: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      tools: [{ name: "create_issue", description: "Open an issue", inputSchema: {} }],
      lastSyncAt: new Date().toISOString(),
    };
    const widened: IntegrationData = value;
    expect(widened.type).toBe("mcp");
  });
});

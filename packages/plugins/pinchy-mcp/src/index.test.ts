/**
 * Unit tests for pinchy-mcp plugin runtime.
 *
 * These tests use a tiny inline HTTP server to mock:
 *   1. The Pinchy credentials API (GET /api/internal/integrations/:id/credentials)
 *   2. The MCP server (POST / — JSON-RPC tools/call)
 *
 * No dependency on packages/web or external packages beyond vitest.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import plugin from "./index.js";

// ─── Inline mock servers ──────────────────────────────────────────────────────

interface MockServers {
  pinchyPort: number;
  mcpPort: number;
  stopPinchy: () => Promise<void>;
  stopMcp: () => Promise<void>;
}

let servers: MockServers;

// Mutable state shared between tests
let credentialFetchCount = 0;
let currentToken = "token-abc";
let mcpCallCount = 0;

function startServer(handler: (req: any, res: any) => void): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer(handler);
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        stop: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

beforeAll(async () => {
  const pinchy = await startServer((req, res) => {
    const auth = req.headers["authorization"];
    if (auth !== "Bearer gw-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const match = req.url?.match(/^\/api\/internal\/integrations\/([^/]+)\/credentials$/);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    credentialFetchCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ credentials: { token: currentToken } }));
  });

  const mcp = await startServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    mcpCallCount++;

    // Check auth
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${currentToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", expected: `Bearer ${currentToken}`, got: auth }));
      return;
    }

    const rpc = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        content: [{ type: "text", text: `result of ${rpc.params?.name}` }],
      },
    }));
  });

  servers = {
    pinchyPort: pinchy.port,
    mcpPort: mcp.port,
    stopPinchy: pinchy.stop,
    stopMcp: mcp.stop,
  };
});

afterAll(async () => {
  await servers.stopPinchy();
  await servers.stopMcp();
});

beforeEach(() => {
  credentialFetchCount = 0;
  mcpCallCount = 0;
  currentToken = "token-abc";
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

interface RegisteredTool {
  factory: (ctx: { agentId?: string }) => {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
  } | null;
  opts: { name?: string };
}

function buildApi(config: object) {
  const tools: RegisteredTool[] = [];
  const api = {
    pluginConfig: config,
    registerTool: (factory: RegisteredTool["factory"], opts?: { name?: string }) => {
      tools.push({ factory, opts: opts ?? {} });
    },
  };
  (plugin as any).register(api);
  return tools;
}

function findTool(tools: RegisteredTool[], toolId: string, agentId: string) {
  const entry = tools.find((t) => t.opts.name === toolId);
  if (!entry) throw new Error(`Tool ${toolId} not registered. Registered: ${tools.map(t => t.opts.name).join(", ")}`);
  const tool = entry.factory({ agentId });
  if (!tool) throw new Error(`Tool factory for ${toolId} returned null for agent ${agentId}`);
  return tool;
}

function makeConfig(overrides: Partial<{
  connectionId: string;
  toolPrefix: string;
  agentTools: Record<string, string[]>;
  agentId: string;
}> = {}) {
  const {
    connectionId = "conn-1",
    toolPrefix = "github_",
    agentTools = { "agent-1": ["create_issue", "list_repos"] },
  } = overrides;

  return {
    apiBaseUrl: `http://127.0.0.1:${servers.pinchyPort}`,
    gatewayToken: "gw-token",
    connections: [
      {
        connectionId,
        preset: "github",
        transport: "http",
        url: `http://127.0.0.1:${servers.mcpPort}/`,
        toolPrefix,
        agentTools,
      },
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("pinchy-mcp plugin runtime", () => {
  describe("lazy credential fetch", () => {
    it("fetches credentials once and caches them across multiple tool calls", async () => {
      const config = makeConfig();
      const tools = buildApi(config);

      const tool = findTool(tools, "github_create_issue", "agent-1");

      // First call: should fetch credentials
      await tool.execute("call-1", { title: "Bug" });
      expect(credentialFetchCount).toBe(1);

      // Second call: should reuse cached credentials
      await tool.execute("call-2", { title: "Another bug" });
      expect(credentialFetchCount).toBe(1);
    });
  });

  describe("401 triggers credential refresh and one retry", () => {
    it("invalidates cache and retries once on 401 from MCP server", async () => {
      // We'll simulate: first call is 401 (stale token), then we update the token
      // and the retry with the new token succeeds
      currentToken = "old-token";

      // Pre-populate config so first fetch returns "old-token"
      const config = makeConfig();
      const tools = buildApi(config);
      const tool = findTool(tools, "github_create_issue", "agent-1");

      // First call will succeed with old-token (just verifying setup)
      const firstResult = await tool.execute("call-1", { title: "Bug" });
      expect(firstResult.isError).toBeFalsy();
      expect(credentialFetchCount).toBe(1);

      // Now rotate the token on the server side — cached token is stale
      currentToken = "new-token";

      // Next MCP call will get 401 because the plugin still has old-token
      // The plugin should: detect 401, invalidate cache, fetch new credentials, retry
      const result = await tool.execute("call-2", { title: "After rotation" });

      // The result should succeed (second fetch returned new-token, retry succeeded)
      expect(result.isError).toBeFalsy();
      // Credentials were fetched twice total (once initially, once after 401)
      expect(credentialFetchCount).toBe(2);
    });
  });

  describe("allow-list enforcement", () => {
    it("returns error envelope without calling MCP when tool is not in agent's allow-list", async () => {
      // agent-1 can only create_issue; agent-2 can also list_repos.
      // list_repos IS registered (because agent-2 has it), but agent-1
      // must not be able to call it.
      const config = makeConfig({
        agentTools: {
          "agent-1": ["create_issue"], // list_repos NOT in agent-1's allowlist
          "agent-2": ["create_issue", "list_repos"],
        },
      });
      const tools = buildApi(config);

      // github_list_repos is registered (agent-2 has it).
      // Calling it as agent-1 must return an error envelope, not call MCP.
      const tool = findTool(tools, "github_list_repos", "agent-1");

      const result = await tool.execute("call-1", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not allowed|permission|allow/i);
      // The MCP server was NOT called
      expect(mcpCallCount).toBe(0);
    });
  });

  describe("multiple connections with distinct tool ids", () => {
    it("two connections with same preset but different connectionIds get distinct tool registrations", async () => {
      const config = {
        apiBaseUrl: `http://127.0.0.1:${servers.pinchyPort}`,
        gatewayToken: "gw-token",
        connections: [
          {
            connectionId: "conn-gh-1",
            preset: "github",
            transport: "http",
            url: `http://127.0.0.1:${servers.mcpPort}/`,
            toolPrefix: "gh1_",
            agentTools: { "agent-1": ["create_issue"] },
          },
          {
            connectionId: "conn-gh-2",
            preset: "github",
            transport: "http",
            url: `http://127.0.0.1:${servers.mcpPort}/`,
            toolPrefix: "gh2_",
            agentTools: { "agent-1": ["create_issue"] },
          },
        ],
      };

      const tools = buildApi(config);
      const toolNames = tools.map((t) => t.opts.name);

      // Both connections expose their own prefixed tools
      expect(toolNames).toContain("gh1_create_issue");
      expect(toolNames).toContain("gh2_create_issue");

      // Calling each goes to the right connection (credential fetch per connection)
      const tool1 = findTool(tools, "gh1_create_issue", "agent-1");
      const tool2 = findTool(tools, "gh2_create_issue", "agent-1");

      await tool1.execute("call-1", { title: "Issue on conn 1" });
      await tool2.execute("call-2", { title: "Issue on conn 2" });

      // Each connection fetched its own credentials
      expect(credentialFetchCount).toBe(2);
    });
  });
});

/**
 * Integration tests for pinchy-odoo against real mock-odoo and mock-pinchy
 * HTTP servers. Layer 2 of the #209 guardrails: catches anything that
 * breaks the actual chain
 *
 *   plugin → fetch credentials from Pinchy → odoo-node → Odoo JSON-RPC
 *
 * end-to-end. The unit tests in `tools.test.ts` mock both `odoo-node` and
 * `fetch`, so a regression in either the credentials-API contract or in
 * the way the apiKey reaches Odoo could slip past them. This file boots
 * an in-process instance of `config/odoo-mock/server.js` plus a tiny
 * in-test HTTP server that emulates Pinchy's
 * `/api/internal/integrations/<id>/credentials` endpoint, and exercises
 * the full chain.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "module";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import plugin from "../index";

const require = createRequire(import.meta.url);

interface MockOdooHandle {
  jsonRpcPort: number;
  controlPort: number;
  stop: () => Promise<void>;
}

interface AgentTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

let mockOdoo: MockOdooHandle;
let mockPinchy: Server;
let mockPinchyPort: number;
const PINCHY_GATEWAY_TOKEN = "test-gateway-token-integration";

// Per-connection credentials served by the mock-pinchy. Tests can mutate
// this to simulate broken/missing/rotated credentials.
const credentialsByConnectionId = new Map<string, unknown>();

beforeAll(async () => {
  // Mock Odoo on an OS-picked port (no collision with the docker-compose service)
  const mockServer = require("../../../../config/odoo-mock/server.js") as {
    start: (opts: { jsonRpcPort: number; controlPort: number }) => Promise<MockOdooHandle>;
  };
  mockOdoo = await mockServer.start({ jsonRpcPort: 0, controlPort: 0 });

  // Mock Pinchy: implements just the credentials endpoint with the same
  // auth contract Pinchy itself uses (Bearer gateway token).
  mockPinchy = createServer((req, res) => {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${PINCHY_GATEWAY_TOKEN}`) {
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
    const connectionId = match[1];
    const credentials = credentialsByConnectionId.get(connectionId);
    if (credentials === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Connection not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "odoo", credentials }));
  });
  await new Promise<void>((resolve) => mockPinchy.listen(0, resolve));
  mockPinchyPort = (mockPinchy.address() as AddressInfo).port;
});

afterAll(async () => {
  await mockOdoo?.stop();
  if (mockPinchy) {
    await new Promise<void>((resolve, reject) =>
      mockPinchy.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

function createApi(agentConfigs: Record<string, unknown> = {}) {
  const tools: Array<{ factory: (ctx: { agentId?: string }) => AgentTool | null; name: string }> =
    [];
  const api = {
    pluginConfig: {
      apiBaseUrl: `http://127.0.0.1:${mockPinchyPort}`,
      gatewayToken: PINCHY_GATEWAY_TOKEN,
      agents: agentConfigs,
    },
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
      opts?: { name?: string }
    ) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).register(api);
  return tools;
}

function findTool(tools: ReturnType<typeof createApi>, name: string, agentId: string): AgentTool {
  const entry = tools.find((t) => t.name === name);
  if (!entry) throw new Error(`Tool ${name} not registered`);
  const tool = entry.factory({ agentId });
  if (!tool) throw new Error(`Tool ${name} factory returned null for agent ${agentId}`);
  return tool;
}

const agentId = "agent-integration";
const agentConfig = {
  connectionId: "conn-integration",
  permissions: { "sale.order": ["read"], "res.partner": ["read"] },
  modelNames: { "sale.order": "Sales Order", "res.partner": "Contact" },
};

describe("pinchy-odoo against real mock-odoo + mock-pinchy (#209 layer 2)", () => {
  beforeAll(() => {
    // Default: well-formed credentials pointing at the in-process mock-odoo.
    credentialsByConnectionId.set("conn-integration", {
      url: `http://127.0.0.1:${mockOdoo.jsonRpcPort}`,
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    });
  });

  it("odoo_schema returns the model's fields after a real round-trip through Pinchy + Odoo", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_schema", agentId);

    const result = await tool.execute("call-1", { model: "sale.order" });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe("Sales Order");
    expect(data.fields.length).toBeGreaterThan(0);
    expect(data.fields.some((f: { name: string }) => f.name === "name")).toBe(true);
  });

  it("odoo_count returns { count: number } for an empty filter", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId);

    const result = await tool.execute("call-1", { model: "sale.order", filters: [] });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.count).toBe("number");
  });

  it("odoo_read returns records and total for an empty filter", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId);

    const result = await tool.execute("call-1", { model: "sale.order", filters: [] });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.records)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("REGRESSION (#209): if Pinchy returns the SecretRef-shaped dict instead of credentials, the plugin fails fast WITHOUT producing a Python crash", async () => {
    // Exactly the bug shape from staging: the credentials API returns the
    // unresolved SecretRef object instead of decrypted credentials. The
    // plugin must reject it at the boundary, not forward it to Odoo (which
    // would crash the Python server with `unhashable type: 'dict'`).
    credentialsByConnectionId.set("conn-integration", {
      source: "file",
      provider: "pinchy",
      id: "/integrations/conn-integration/odooApiKey",
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_schema", agentId);

    const result = await tool.execute("call-1", { model: "sale.order" });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("must be a string");
    expect(text).toContain("#209");
    // Critically: the plugin must not have produced the Python crash text
    // — meaning the request never reached Odoo with the broken payload.
    expect(text).not.toContain("unhashable type");

    // Restore for subsequent tests
    credentialsByConnectionId.set("conn-integration", {
      url: `http://127.0.0.1:${mockOdoo.jsonRpcPort}`,
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    });
  });

  it("surfaces a clear error when Pinchy returns 404 for an unknown connectionId", async () => {
    const tools = createApi({
      [agentId]: { ...agentConfig, connectionId: "unknown-connection-id" },
    });
    const tool = findTool(tools, "odoo_schema", agentId);

    const result = await tool.execute("call-1", { model: "sale.order" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });
});

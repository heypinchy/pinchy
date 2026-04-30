/**
 * Integration tests for pinchy-odoo against the real mock-odoo HTTP server.
 *
 * Layer 2 of the #209 guardrails: catches anything that breaks the actual
 * plugin → odoo-node → Odoo JSON-RPC chain end-to-end. Layer 1 (unit tests
 * in `tools.test.ts`) mock `odoo-node` away, so a regression in the way
 * Pinchy's `apiKey` reaches Odoo (e.g. shape, encoding, header placement)
 * would slip past them. This file uses the real `odoo-node` library
 * against an in-process instance of `config/odoo-mock/server.js`.
 *
 * The original bug: Pinchy wrote the apiKey as a SecretRef object,
 * `odoo-node` forwarded that dict to Odoo, and Odoo crashed with
 * `unhashable type: 'dict'`. With this test in place, that exact
 * regression — or any future variant where the wrong shape reaches
 * Odoo over the wire — fails CI on a real RPC round-trip.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "module";
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

beforeAll(async () => {
  // Use port 0 so the OS picks an unused port — avoids collisions with
  // any other mock-odoo running on the same host (docker-compose, etc.).
  const mockServer = require("../../../../config/odoo-mock/server.js") as {
    start: (opts: { jsonRpcPort: number; controlPort: number }) => Promise<MockOdooHandle>;
  };
  mockOdoo = await mockServer.start({ jsonRpcPort: 0, controlPort: 0 });
});

afterAll(async () => {
  await mockOdoo?.stop();
});

function createApi(agentConfigs: Record<string, unknown> = {}) {
  const tools: Array<{ factory: (ctx: { agentId?: string }) => AgentTool | null; name: string }> =
    [];
  const api = {
    pluginConfig: { agents: agentConfigs },
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

function buildAgentConfig(overrides: Partial<{ apiKey: unknown; uid: unknown }> = {}) {
  return {
    connection: {
      name: "Mock Odoo",
      description: "In-process mock for integration tests",
      url: `http://127.0.0.1:${mockOdoo.jsonRpcPort}`,
      db: "testdb",
      uid: overrides.uid ?? 2,
      // The default apiKey here is a plain string — exactly what Pinchy
      // should be writing into the plugin config (the bug-fixing shape).
      apiKey: overrides.apiKey ?? "test-api-key",
    },
    permissions: {
      "sale.order": ["read"],
      "res.partner": ["read"],
    },
    modelNames: { "sale.order": "Sales Order", "res.partner": "Contact" },
  };
}

describe("pinchy-odoo against real mock-odoo (#209 layer 2)", () => {
  it("odoo_schema returns the model's fields when apiKey is a plain string", async () => {
    const tools = createApi({ [agentId]: buildAgentConfig() });
    const tool = findTool(tools, "odoo_schema", agentId);

    const result = await tool.execute("call-1", { model: "sale.order" });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe("Sales Order");
    expect(data.fields.length).toBeGreaterThan(0);
    expect(data.fields.some((f: { name: string }) => f.name === "name")).toBe(true);
  });

  it("odoo_count returns { count: number } for an empty filter", async () => {
    const tools = createApi({ [agentId]: buildAgentConfig() });
    const tool = findTool(tools, "odoo_count", agentId);

    const result = await tool.execute("call-1", { model: "sale.order", filters: [] });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.count).toBe("number");
  });

  it("odoo_read returns records and total for an empty filter", async () => {
    const tools = createApi({ [agentId]: buildAgentConfig() });
    const tool = findTool(tools, "odoo_read", agentId);

    const result = await tool.execute("call-1", { model: "sale.order", filters: [] });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.records)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("REGRESSION: odoo_schema fails fast with a clear error when apiKey is the SecretRef dict (#209)", async () => {
    // This is exactly the bug shape from staging: Pinchy used to write
    // apiKey as an unresolved SecretRef object, OpenClaw didn't resolve
    // it, the plugin forwarded the dict to Odoo, and Odoo crashed with
    // `unhashable type: 'dict'`. With the layer-3 runtime check in
    // `createClient`, the plugin now refuses to start a request whose
    // apiKey isn't a string — the user gets a clear plugin-side error
    // instead of a confusing Python crash.
    const brokenConfig = buildAgentConfig({
      apiKey: { source: "file", provider: "pinchy", id: "/integrations/x/odooApiKey" },
    });
    const tools = createApi({ [agentId]: brokenConfig });
    const tool = findTool(tools, "odoo_schema", agentId);

    const result = await tool.execute("call-1", { model: "sale.order" });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("apiKey must be a string");
    expect(text).toContain("#209");
    // Crucially, the error should NOT be the Python crash message —
    // i.e. the request should never reach Odoo if the shape is wrong.
    expect(text).not.toContain("unhashable type");
  });
});

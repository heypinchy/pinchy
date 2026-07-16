// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentOdooConfig } from "../index";

const mockSearchRead = vi.fn();
const mockSearchCount = vi.fn();
const mockReadGroup = vi.fn();
const mockCreate = vi.fn();
const mockWrite = vi.fn();
const mockUnlink = vi.fn();
const mockFields = vi.fn();
const mockCallMethod = vi.fn();

vi.mock("odoo-node", () => {
  const MockOdooClient = vi.fn(function (this: Record<string, unknown>) {
    this.searchRead = mockSearchRead;
    this.searchCount = mockSearchCount;
    this.readGroup = mockReadGroup;
    this.create = mockCreate;
    this.write = mockWrite;
    this.unlink = mockUnlink;
    this.fields = mockFields;
    this.callMethod = mockCallMethod;
  });
  return { OdooClient: MockOdooClient };
});

vi.mock("../io", () => ({ readFile: vi.fn(), stat: vi.fn() }));

import { hasItemWrappedArray } from "../index";
import plugin from "../index";

// Pattern B: the plugin lazily fetches credentials, so a stubbed endpoint is
// required before any tool executes.
const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({
    type: "odoo",
    credentials: {
      url: "http://odoo-test:8069",
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    },
  }),
}));
globalThis.fetch = fetchMock as unknown as typeof fetch;

interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function createApi(agentConfigs: Record<string, AgentOdooConfig> = {}) {
  const tools: Array<{
    factory: (ctx: { agentId?: string }) => AgentTool | null;
    name: string;
  }> = [];
  const api = {
    pluginConfig: {
      apiBaseUrl: "http://pinchy-test:7777",
      gatewayToken: "test-gateway-token",
      agents: agentConfigs,
    },
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
      opts?: { name?: string },
    ) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };
  plugin.register(api as never);
  return tools;
}

function findTool(
  tools: ReturnType<typeof createApi>,
  name: string,
  agentId?: string,
): AgentTool | null {
  const entry = tools.find((t) => t.name === name);
  if (!entry) return null;
  return entry.factory({ agentId });
}

const agentId = "agent-1";
const CONN = "conn-test-1";

const PERMS = {
  "account.move": ["read", "create", "write"],
  "res.partner": ["read", "create", "write"],
};

function cfg(): AgentOdooConfig {
  return { connectionId: CONN, permissions: PERMS } as AgentOdooConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  mockFields.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Unit: the pure detector for the {item: …} array-serialization artifact.
// Certain models (e.g. ollama-cloud/deepseek-v4-pro) emit array tool-args
// wrapped as single-key {item: …} objects, nested for nested arrays. Verified
// against the real production trajectory (pinchy-bugreport-penny-20260716).
// ---------------------------------------------------------------------------
describe("hasItemWrappedArray", () => {
  it("detects a single {item: …} wrapper", () => {
    expect(hasItemWrappedArray({ item: [1, 2, 3] })).toBe(true);
  });

  it("detects nested {item:{item: …}} wrapping", () => {
    expect(
      hasItemWrappedArray({ tax_ids: { item: { item: ["6", "0", { item: "172" }] } } }),
    ).toBe(true);
  });

  it("detects wrapping nested inside a real array", () => {
    expect(hasItemWrappedArray([{ item: [1] }])).toBe(true);
  });

  it("passes a well-formed one2many command list", () => {
    expect(
      hasItemWrappedArray({ invoice_line_ids: [[0, 0, { account_id: 5, name: "x" }]] }),
    ).toBe(false);
  });

  it("passes a well-formed many2many command list", () => {
    expect(hasItemWrappedArray({ tax_ids: [[6, 0, [172]]] })).toBe(false);
  });

  it("does not flag a normal record whose fields are unrelated", () => {
    expect(hasItemWrappedArray({ name: "Acme", ref: "INV/1", amount: 10 })).toBe(false);
  });

  it("does not flag a multi-key object that merely contains an 'item' key", () => {
    expect(hasItemWrappedArray({ item: 3, quantity: 1 })).toBe(false);
  });

  it("is safe on primitives and empties", () => {
    expect(hasItemWrappedArray(null)).toBe(false);
    expect(hasItemWrappedArray("item")).toBe(false);
    expect(hasItemWrappedArray([])).toBe(false);
    expect(hasItemWrappedArray({})).toBe(false);
  });
});

describe("odoo_create — {item: …} array-wrapping", () => {
  it("refuses item-wrapped values with an actionable message, before touching Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_create", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      values: {
        move_type: "in_invoice",
        invoice_line_ids: { item: { item: ["0", "0", { account_id: "7600 Office supplies" }] } },
      },
    });

    expect(result.isError).toBe(true);
    // Names the artifact and shows the correct shape so the model can retry.
    expect(result.content[0].text).toMatch(/item/i);
    expect(result.content[0].text).toMatch(/\[\[0, 0,/); // the correct o2m shape
    // Must not have forwarded the garbage to Odoo.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFields).not.toHaveBeenCalled();
  });

  it("still creates normally when arrays are well-formed", async () => {
    mockCreate.mockResolvedValue(42);
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_create", agentId)!;
    const result = await tool.execute("c", {
      model: "res.partner",
      values: { name: "Acme", category_id: [[6, 0, [1, 2]]] },
    });
    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalled();
  });
});

describe("odoo_read — {item: …} array-wrapping", () => {
  it("refuses an item-wrapped domain before querying Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      filters: { item: { item: ["id", "in", ["757", "758"]] } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/item/i);
    expect(mockSearchRead).not.toHaveBeenCalled();
    expect(mockFields).not.toHaveBeenCalled();
  });

  it("refuses item-wrapped fields before querying Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      fields: { item: ["id", "name"] },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/item/i);
    expect(mockSearchRead).not.toHaveBeenCalled();
  });

  it("still reads normally with a well-formed domain", async () => {
    mockSearchRead.mockResolvedValue({ records: [], length: 0 });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      filters: [["state", "=", "posted"]],
    });
    expect(result.isError).toBeFalsy();
    expect(mockSearchRead).toHaveBeenCalled();
  });
});

describe("relation-field name string — Postgres integer error is translated", () => {
  it("turns a raw 'invalid input syntax for type integer' into actionable guidance", async () => {
    mockCreate.mockRejectedValue(
      new Error(
        'invalid input syntax for type integer: "7600 Office supplies and printed forms"',
      ),
    );
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_create", agentId)!;
    const result = await tool.execute("c", {
      model: "res.partner",
      values: { name: "Acme" },
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // Keeps the original signal but adds what to do about it.
    expect(text).toMatch(/invalid input syntax for type integer/i);
    expect(text).toMatch(/relation|odoo_read|numeric id|_pinchy_ref/i);
  });
});

describe("tool descriptions carry a correct-shape example", () => {
  it("odoo_create description shows the plain-array command shape and warns against {item}", () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_create", agentId)!;
    expect(tool.description).toMatch(/\[\[0, 0,/);
    expect(tool.description).toMatch(/item/i);
  });

  it("odoo_read filters description warns against {item} wrapping", () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;
    const props = (tool.parameters as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.filters.description).toMatch(/item/i);
  });
});

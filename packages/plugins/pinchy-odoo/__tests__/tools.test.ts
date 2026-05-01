import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock odoo-node before importing the plugin
const mockSearchRead = vi.fn();
const mockSearchCount = vi.fn();
const mockReadGroup = vi.fn();
const mockCreate = vi.fn();
const mockWrite = vi.fn();
const mockUnlink = vi.fn();
const mockFields = vi.fn();

vi.mock("odoo-node", () => {
  const MockOdooClient = vi.fn(function (this: Record<string, unknown>) {
    this.searchRead = mockSearchRead;
    this.searchCount = mockSearchCount;
    this.readGroup = mockReadGroup;
    this.create = mockCreate;
    this.write = mockWrite;
    this.unlink = mockUnlink;
    this.fields = mockFields;
  });
  return { OdooClient: MockOdooClient };
});

import { OdooClient } from "odoo-node";
import plugin from "../index";

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown }>;
}

// The plugin no longer takes credentials in its config — it fetches them
// on demand from Pinchy's internal credentials API. Tests stub `fetch`
// to return a canonical credentials response for any connectionId.
const testCredentials = {
  url: "https://odoo.example.com",
  db: "testdb",
  uid: 2,
  apiKey: "test-api-key",
};

const testPermissions = {
  "sale.order": ["read"],
  "res.partner": ["read", "write", "create"],
};

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({ type: "odoo", credentials: testCredentials }),
}));
// Vitest typing dance: cast through unknown for mock fetch
globalThis.fetch = fetchMock as unknown as typeof fetch;

function createApi(agentConfigs: Record<string, unknown> = {}) {
  const tools: Array<{ factory: (ctx: { agentId?: string }) => AgentTool | null; name: string }> = [];

  const api = {
    pluginConfig: {
      apiBaseUrl: "http://pinchy-test:7777",
      gatewayToken: "test-gateway-token",
      agents: agentConfigs,
    },
    registerTool: (factory: (ctx: { agentId?: string }) => AgentTool | null, opts?: { name?: string }) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };

  plugin.register(api);
  return tools;
}

function findTool(tools: ReturnType<typeof createApi>, name: string, agentId?: string): AgentTool | null {
  const entry = tools.find((t) => t.name === name);
  if (!entry) return null;
  return entry.factory({ agentId });
}

const agentId = "agent-1";
const agentConfig = {
  connectionId: "conn-test-1",
  permissions: testPermissions,
  modelNames: {
    "sale.order": "Sales Order",
    "res.partner": "Contact",
    "account.move": "Journal Entry",
  },
};

describe("tool registration", () => {
  it("registers all 7 tools", () => {
    const tools = createApi({ [agentId]: agentConfig });
    expect(tools).toHaveLength(7);
    const names = tools.map((t) => t.name);
    expect(names).toContain("odoo_schema");
    expect(names).toContain("odoo_read");
    expect(names).toContain("odoo_count");
    expect(names).toContain("odoo_aggregate");
    expect(names).toContain("odoo_create");
    expect(names).toContain("odoo_write");
    expect(names).toContain("odoo_delete");
  });

  it("returns null for all tools when no agentId", () => {
    const tools = createApi({ [agentId]: agentConfig });
    for (const tool of tools) {
      expect(tool.factory({})).toBeNull();
    }
  });

  it("returns null for all tools when agent has no config", () => {
    const tools = createApi({ [agentId]: agentConfig });
    for (const tool of tools) {
      expect(tool.factory({ agentId: "unknown-agent" })).toBeNull();
    }
  });
});

describe("odoo_schema", () => {
  it("lists only permitted models when called without parameters", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_schema", agentId)!;
    expect(tool).not.toBeNull();

    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text);
    // Only sale.order and res.partner are in permissions (not account.move)
    expect(data).toHaveLength(2);
    expect(data).toContainEqual({ model: "sale.order", name: "Sales Order" });
    expect(data).toContainEqual({ model: "res.partner", name: "Contact" });
  });

  it("returns fields for a specific permitted model", async () => {
    const expectedFields = [
      { name: "name", string: "Order Reference", type: "char", required: true, readonly: true },
      { name: "partner_id", string: "Customer", type: "many2one", required: true, readonly: false, relation: "res.partner" },
      { name: "amount_total", string: "Total", type: "monetary", required: false, readonly: true },
    ];
    mockFields.mockResolvedValue(expectedFields);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_schema", agentId)!;

    const result = await tool.execute("call-2", { model: "sale.order" });
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe("Sales Order");
    expect(data.fields).toHaveLength(3);
    expect(data.fields[0].name).toBe("name");
    expect(mockFields).toHaveBeenCalledWith("sale.order");
  });

  it("denies access to unpermitted model schema", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_schema", agentId)!;

    const result = await tool.execute("call-3", { model: "account.move" });
    expect(result.content[0].text).toContain("not available");
    expect(result.isError).toBe(true);
  });
});

describe("odoo_read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads records with correct parameters", async () => {
    mockSearchRead.mockResolvedValue({
      records: [{ id: 1, name: "SO001" }],
      total: 1,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [["state", "=", "sale"]],
      fields: ["name", "amount_total"],
      limit: 10,
      offset: 0,
      order: "date_order desc",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.records).toHaveLength(1);
    expect(data.total).toBe(1);

    expect(mockSearchRead).toHaveBeenCalledWith(
      "sale.order",
      [["state", "=", "sale"]],
      { fields: ["name", "amount_total"], limit: 10, offset: 0, order: "date_order desc" },
    );
  });

  it("denies read on unpermitted model", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-2", {
      model: "account.move",
      filters: [],
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("account.move");
    expect(result.isError).toBe(true);
    expect(mockSearchRead).not.toHaveBeenCalled();
  });
});

describe("odoo_count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts records for a permitted model", async () => {
    mockSearchCount.mockResolvedValue(42);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [["state", "=", "sale"]],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(42);
    expect(mockSearchCount).toHaveBeenCalledWith("sale.order", [["state", "=", "sale"]]);
  });

  it("denies count on unpermitted model", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId)!;

    const result = await tool.execute("call-2", {
      model: "account.move",
      filters: [],
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
  });
});

describe("odoo_aggregate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates data for a permitted model", async () => {
    mockReadGroup.mockResolvedValue({
      groups: [{ partner_id: [1, "Customer A"], amount_total: 1500, __count: 3 }],
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_aggregate", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
      fields: ["partner_id", "amount_total:sum"],
      groupby: ["partner_id"],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.groups).toHaveLength(1);
    expect(mockReadGroup).toHaveBeenCalledWith(
      "sale.order",
      [],
      ["partner_id", "amount_total:sum"],
      ["partner_id"],
      { limit: undefined, offset: undefined, orderby: undefined },
    );
  });

  it("denies aggregation on unpermitted model", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_aggregate", agentId)!;

    const result = await tool.execute("call-2", {
      model: "account.move",
      filters: [],
      fields: ["amount_total:sum"],
      groupby: ["partner_id"],
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
  });
});

describe("odoo_create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a record on a permitted model", async () => {
    mockCreate.mockResolvedValue(42);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      values: { name: "New Partner", email: "new@example.com" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe(42);
    expect(mockCreate).toHaveBeenCalledWith("res.partner", { name: "New Partner", email: "new@example.com" });
  });

  it("denies create on model without create permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-2", {
      model: "sale.order",
      values: { name: "SO999" },
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("create");
    expect(result.isError).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("odoo_write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates records on a permitted model", async () => {
    mockWrite.mockResolvedValue(true);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      ids: [1, 2],
      values: { email: "updated@example.com" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(mockWrite).toHaveBeenCalledWith("res.partner", [1, 2], { email: "updated@example.com" });
  });

  it("denies write on model without write permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;

    const result = await tool.execute("call-2", {
      model: "sale.order",
      ids: [1],
      values: { name: "updated" },
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("odoo_delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes records on a permitted model", async () => {
    mockUnlink.mockResolvedValue(true);

    // Add delete permission for this test
    const configWithDelete = {
      ...agentConfig,
      permissions: { ...testPermissions, "res.partner": ["read", "write", "create", "delete"] },
    };
    const tools = createApi({ [agentId]: configWithDelete });
    const tool = findTool(tools, "odoo_delete", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      ids: [5, 6],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(mockUnlink).toHaveBeenCalledWith("res.partner", [5, 6]);
  });

  it("denies delete on model without delete permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_delete", agentId)!;

    const result = await tool.execute("call-2", {
      model: "res.partner",
      ids: [1],
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

describe("error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error message when Odoo client throws", async () => {
    mockSearchRead.mockRejectedValue(new Error("Connection refused"));

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.content[0].text).toContain("Error: Connection refused");
    expect(result.isError).toBe(true);
  });

  it("returns permission message for Odoo access errors", async () => {
    mockSearchRead.mockRejectedValue(new Error("AccessError: no read access on sale.order"));

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.content[0].text).toContain("denied permission");
    expect(result.isError).toBe(true);
  });

  it("does not treat 'Failed to access host' as a permission error", async () => {
    mockSearchRead.mockRejectedValue(new Error("Failed to access host"));

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.content[0].text).not.toContain("denied permission");
    expect(result.content[0].text).toContain("Error: Failed to access host");
    expect(result.isError).toBe(true);
  });

  it("handles non-Error throws gracefully", async () => {
    mockSearchRead.mockRejectedValue("string error");

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.content[0].text).toContain("Error: Unknown error");
    expect(result.isError).toBe(true);
  });
});

describe("client caching (#209 layer 2: credentials fetched lazily, cached)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ type: "odoo", credentials: testCredentials }),
    } as unknown as Response);
  });

  it("fetches credentials once and reuses the OdooClient across multiple tool calls for the same agent", async () => {
    mockSearchRead.mockResolvedValue({ records: [], total: 0, limit: 100, offset: 0 });
    mockSearchCount.mockResolvedValue(0);

    const tools = createApi({ [agentId]: agentConfig });
    const readTool = findTool(tools, "odoo_read", agentId)!;
    const countTool = findTool(tools, "odoo_count", agentId)!;

    await readTool.execute("call-1", { model: "sale.order", filters: [] });
    await readTool.execute("call-2", { model: "sale.order", filters: [] });
    await countTool.execute("call-3", { model: "sale.order", filters: [] });

    // Credentials API hit exactly once across the 3 tool calls
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // OdooClient constructor called exactly once (cached client reused)
    expect(OdooClient).toHaveBeenCalledTimes(1);
  });

  it("fetches credentials separately for different agents (no cross-agent leakage)", async () => {
    mockSearchRead.mockResolvedValue({ records: [], total: 0, limit: 100, offset: 0 });

    const agent2Config = {
      connectionId: "conn-test-2",
      permissions: testPermissions,
    };
    const tools = createApi({ [agentId]: agentConfig, "agent-2": agent2Config });

    const tool1 = findTool(tools, "odoo_read", agentId)!;
    const tool2 = findTool(tools, "odoo_read", "agent-2")!;

    await tool1.execute("call-1", { model: "sale.order", filters: [] });
    await tool2.execute("call-2", { model: "sale.order", filters: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(OdooClient).toHaveBeenCalledTimes(2);
    // Each fetch hit the connectionId-specific path
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("conn-test-1"))).toBe(true);
    expect(urls.some((u) => u.includes("conn-test-2"))).toBe(true);
  });

  it("fails fast with a clear error if the credentials API returns the SecretRef object shape (#209 regression)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        type: "odoo",
        // Exactly the broken shape from staging: an unresolved SecretRef.
        credentials: { source: "file", provider: "pinchy", id: "/integrations/x/odooApiKey" },
      }),
    } as unknown as Response);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId)!;

    const result = await tool.execute("call-1", { model: "sale.order", filters: [] });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("must be a string");
    expect(text).toContain("#209");
  });

  it("invalidates the cache and refetches credentials on auth error", async () => {
    mockSearchRead.mockRejectedValueOnce(new Error("Access Denied: invalid api key"));
    mockSearchRead.mockResolvedValueOnce({ records: [], total: 0, limit: 100, offset: 0 });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", { model: "sale.order", filters: [] });

    expect(result.isError).toBeFalsy();
    // First call fetched, error invalidated cache, second call refetched
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSearchRead).toHaveBeenCalledTimes(2);
  });
});

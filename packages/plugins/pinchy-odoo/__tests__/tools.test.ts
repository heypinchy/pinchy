import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OdooField } from "../index";

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

// Mock the io wrapper for odoo_attach_file tests
const { mockReadFile, mockStat } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));
vi.mock("../io", () => ({ readFile: mockReadFile, stat: mockStat }));

import { OdooClient } from "odoo-node";
import { encodeRef } from "../integration-ref";
import plugin, { compactType, normalizeFields, sortFieldsByPriority, compactSchema } from "../index";

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
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

  plugin.register(api);
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
const agentConfig = {
  connectionId: "conn-test-1",
  permissions: testPermissions,
  modelNames: {
    "sale.order": "Sales Order",
    "res.partner": "Contact",
    "account.move": "Journal Entry",
  },
};

describe("compactType", () => {
  it("maps primitive types to short tokens", () => {
    expect(compactType({ name: "id", type: "integer" })).toBe("int");
    expect(compactType({ name: "name", type: "char" })).toBe("char");
    expect(compactType({ name: "amount", type: "float" })).toBe("float");
    expect(compactType({ name: "active", type: "boolean" })).toBe("bool");
    expect(compactType({ name: "notes", type: "text" })).toBe("text");
    expect(compactType({ name: "date", type: "date" })).toBe("date");
    expect(compactType({ name: "ts", type: "datetime" })).toBe("datetime");
  });

  it("falls back to the raw type string for known-but-unshortened types", () => {
    expect(compactType({ name: "weird", type: "binary" })).toBe("binary");
  });

  it("returns 'unknown' for undefined type", () => {
    expect(compactType({ name: "wtf", type: undefined as unknown as string })).toBe("unknown");
  });

  it("encodes many2one as 'm2o:<relation>'", () => {
    expect(compactType({ name: "partner_id", type: "many2one", relation: "res.partner" })).toBe(
      "m2o:res.partner"
    );
  });

  it("encodes one2many as 'o2m:<relation>'", () => {
    expect(compactType({ name: "line_ids", type: "one2many", relation: "account.move.line" })).toBe(
      "o2m:account.move.line"
    );
  });

  it("encodes many2many as 'm2m:<relation>'", () => {
    expect(compactType({ name: "tag_ids", type: "many2many", relation: "res.partner.category" })).toBe(
      "m2m:res.partner.category"
    );
  });

  it("falls back to '<type>:?' if relation is missing", () => {
    expect(compactType({ name: "x", type: "many2one" })).toBe("m2o:?");
  });

  it("encodes selection as 'selection:<a>|<b>|<c>'", () => {
    expect(
      compactType({
        name: "state",
        type: "selection",
        selection: [
          ["draft", "Draft"],
          ["posted", "Posted"],
          ["cancel", "Cancelled"],
        ],
      })
    ).toBe("selection:draft|posted|cancel");
  });

  it("handles selection with one option", () => {
    expect(
      compactType({
        name: "color",
        type: "selection",
        selection: [["red", "Red"]],
      })
    ).toBe("selection:red");
  });

  it("handles selection without options (empty array)", () => {
    expect(compactType({ name: "x", type: "selection", selection: [] })).toBe("selection:");
  });

  it("handles selection without options (undefined)", () => {
    expect(compactType({ name: "x", type: "selection" })).toBe("selection:");
  });

  it("truncates selection options past 20 with '|...'", () => {
    const opts: Array<[string, string]> = Array.from({ length: 25 }, (_, i) => [
      `opt${i}`,
      `Option ${i}`,
    ]);
    const result = compactType({ name: "x", type: "selection", selection: opts });
    expect(result).toMatch(/^selection:opt0\|opt1\|.*\|opt19\|\.\.\.$/);
    expect(result.split("|")).toHaveLength(21); // 20 opts + "..."
  });

  it("does not truncate selections of exactly 20", () => {
    const opts: Array<[string, string]> = Array.from({ length: 20 }, (_, i) => [
      `opt${i}`,
      `Option ${i}`,
    ]);
    const result = compactType({ name: "x", type: "selection", selection: opts });
    expect(result.endsWith("|...")).toBe(false);
    expect(result.split("|")).toHaveLength(20);
  });
});

describe("normalizeFields", () => {
  it("preserves selection options through normalization", () => {
    const raw = {
      state: {
        name: "state",
        type: "selection",
        string: "Status",
        selection: [
          ["draft", "Draft"],
          ["posted", "Posted"],
        ],
      },
    };
    const result = normalizeFields(raw);
    const stateField = result.find((f) => f.name === "state");
    expect(stateField).toBeDefined();
    expect(stateField!.selection).toEqual([
      ["draft", "Draft"],
      ["posted", "Posted"],
    ]);
  });

  it("preserves readonly and required flags", () => {
    const raw = {
      partner_id: {
        name: "partner_id",
        type: "many2one",
        string: "Partner",
        relation: "res.partner",
        readonly: true,
        required: false,
      },
      name_field: {
        name: "name_field",
        type: "char",
        string: "Name",
        readonly: false,
        required: true,
      },
    };
    const result = normalizeFields(raw);
    const partner = result.find((f) => f.name === "partner_id");
    const nameF = result.find((f) => f.name === "name_field");
    expect(partner?.readonly).toBe(true);
    expect(partner?.required).toBe(false);
    expect(nameF?.readonly).toBe(false);
    expect(nameF?.required).toBe(true);
  });
});

describe("sortFieldsByPriority", () => {
  it("places COMMON_FIELDS first in canonical order, then alphabetical", () => {
    const input: OdooField[] = [
      { name: "x_custom_field", type: "char" },
      { name: "amount_total", type: "float" },
      { name: "id", type: "integer" },
      { name: "partner_id", type: "many2one", relation: "res.partner" },
      { name: "active", type: "boolean" },
      { name: "z_alpha_last", type: "char" },
      { name: "name", type: "char" },
    ];
    const sorted = sortFieldsByPriority(input);
    expect(sorted.map((f) => f.name)).toEqual([
      "id",
      "name",
      "active",
      "partner_id",
      "amount_total",
      "x_custom_field",
      "z_alpha_last",
    ]);
  });

  it("is a pure function — does not mutate input", () => {
    const input: OdooField[] = [
      { name: "b", type: "char" },
      { name: "a", type: "char" },
    ];
    sortFieldsByPriority(input);
    expect(input.map((f) => f.name)).toEqual(["b", "a"]);
  });
});

describe("compactSchema", () => {
  const baseFields: OdooField[] = [
    { name: "id", type: "integer" },
    { name: "name", type: "char" },
    { name: "partner_id", type: "many2one", relation: "res.partner" },
  ];

  it("returns compact field map keyed by name with short type codes", () => {
    const out = compactSchema(baseFields, { limit: 40, verbose: false });
    expect(out.fields).toEqual({
      id: "int",
      name: "char",
      partner_id: "m2o:res.partner",
    });
  });

  it("includes _meta with total/returned/truncated", () => {
    const out = compactSchema(baseFields, { limit: 40, verbose: false });
    expect(out._meta).toEqual({
      total: 3,
      returned: 3,
      truncated: false,
    });
  });

  it("with fields:[a,b] returns only those (ignoring limit)", () => {
    const fs: OdooField[] = [
      { name: "a", type: "char" },
      { name: "b", type: "char" },
      { name: "c", type: "char" },
    ];
    const out = compactSchema(fs, { fields: ["a", "b"], limit: 1, verbose: false });
    expect(Object.keys(out.fields)).toEqual(["a", "b"]);
    expect(out._meta.returned).toBe(2);
    expect(out._meta.truncated).toBe(false);
  });

  it("with fields:[unknown] returns empty fields + hint", () => {
    const fs: OdooField[] = [{ name: "a", type: "char" }];
    const out = compactSchema(fs, { fields: ["does_not_exist"], limit: 40, verbose: false });
    expect(out.fields).toEqual({});
    expect(out._meta.returned).toBe(0);
    expect(out._meta.hint).toMatch(/no requested fields/i);
  });

  it("with fields:['__all__'] returns every field, no limit", () => {
    const fs: OdooField[] = Array.from({ length: 50 }, (_, i) => ({
      name: `f${i}`,
      type: "char" as const,
    }));
    const out = compactSchema(fs, { fields: ["__all__"], limit: 40, verbose: false });
    expect(out._meta.returned).toBe(50);
    expect(out._meta.truncated).toBe(false);
  });

  it("emits truncation hint when truncated", () => {
    const fs: OdooField[] = Array.from({ length: 50 }, (_, i) => ({
      name: `f${i}`,
      type: "char" as const,
    }));
    const out = compactSchema(fs, { limit: 10, verbose: false });
    expect(out._meta.truncated).toBe(true);
    expect(out._meta.returned).toBe(10);
    expect(out._meta.hint).toMatch(/__all__/);
  });

  it("verbose:true returns full Odoo metadata (readonly/required/string)", () => {
    const fs: OdooField[] = [
      {
        name: "name",
        type: "char",
        readonly: false,
        required: true,
        string: "Name",
      },
    ];
    const out = compactSchema(fs, { limit: 40, verbose: true });
    expect(out.fields).toEqual({
      name: {
        type: "char",
        required: true,
        readonly: false,
        string: "Name",
      },
    });
  });

  it("verbose:true does not omit falsy flags", () => {
    const fs: OdooField[] = [
      {
        name: "id",
        type: "integer",
        readonly: true,
        required: false,
        string: "ID",
      },
    ];
    const out = compactSchema(fs, { limit: 40, verbose: true });
    expect((out.fields.id as { readonly: boolean }).readonly).toBe(true);
  });
});

describe("odoo_list_models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only models with read permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_list_models", agentId)!;
    expect(tool).toBeTruthy();

    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text) as { models: Array<{ model: string; name: string; operations: string[] }> };
    expect(data.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "res.partner" }),
      ])
    );
    expect(data.models.length).toBeGreaterThan(0);
  });

  it("returns empty when agent has no permissions", async () => {
    const tools = createApi({ [agentId]: { ...agentConfig, permissions: {} } });
    const tool = findTool(tools, "odoo_list_models", agentId)!;
    expect(tool).toBeTruthy();
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text) as { models: unknown[] };
    expect(data.models).toEqual([]);
  });
});

describe("tool registration", () => {
  it("registers all 9 tools", () => {
    const tools = createApi({ [agentId]: agentConfig });
    expect(tools).toHaveLength(9);
    const names = tools.map((t) => t.name);
    expect(names).toContain("odoo_list_models");
    expect(names).toContain("odoo_describe_model");
    expect(names).toContain("odoo_read");
    expect(names).toContain("odoo_count");
    expect(names).toContain("odoo_aggregate");
    expect(names).toContain("odoo_create");
    expect(names).toContain("odoo_write");
    expect(names).toContain("odoo_delete");
    expect(names).toContain("odoo_attach_file");
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

describe("odoo_describe_model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects calls without a model parameter", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId)!;
    expect(tool).toBeTruthy();

    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/model.*required/i);
  });

  it("returns compact field map for a permitted model", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer" },
      { name: "name", type: "char" },
      { name: "partner_id", type: "many2one", relation: "res.partner" },
    ]);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId)!;

    const result = await tool.execute("call-1", { model: "res.partner" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { model: string; fields: Record<string, unknown>; _meta: { total: number; returned: number; truncated: boolean } };
    expect(data.model).toBe("res.partner");
    expect(data.fields).toBeDefined();
    expect(data._meta).toBeDefined();
    expect(data._meta.returned).toBeGreaterThan(0);
  });

  it("denies access to unpermitted models", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId)!;

    const result = await tool.execute("call-1", { model: "stock.move" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available/i);
  });
});

describe("odoo_schema removed", () => {
  it("does not register a tool named odoo_schema", () => {
    const tools = createApi({ [agentId]: agentConfig });
    expect(tools.find((t) => t.name === "odoo_schema")).toBeUndefined();
  });
});

describe("odoo_read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
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
      {
        fields: ["name", "amount_total"],
        limit: 10,
        offset: 0,
        order: "date_order desc",
      },
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

  it("returns many2one values as opaque refs with labels", async () => {
    mockFields.mockResolvedValue([
      { name: "id", string: "ID", type: "integer" },
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [{ id: 7, name: "Wien Partner", country_id: [14, "Austria"] }],
      total: 1,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-ref-read", {
      model: "res.partner",
      filters: [],
      fields: ["name", "country_id"],
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.records[0].country_id).toEqual({
      ref: expect.stringMatching(/^pinchy_ref:v1:/),
      label: "Austria",
      model: "res.country",
    });
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
    expect(mockSearchCount).toHaveBeenCalledWith("sale.order", [
      ["state", "=", "sale"],
    ]);
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
      groups: [
        { partner_id: [1, "Customer A"], amount_total: 1500, __count: 3 },
      ],
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
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
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
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "New Partner",
      email: "new@example.com",
    });
  });

  it("resolves country_id by exact country name instead of using the first same-letter country", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 1, name: "Aruba", code: "AW" },
        { id: 14, name: "Austria", code: "AT" },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });
    mockCreate.mockResolvedValue(42);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-name", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: "Austria" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "Wien Partner",
      country_id: 14,
    });
  });

  it("rejects raw numeric country_id values", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-raw-id", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: 14 },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Raw numeric IDs are not accepted",
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("resolves country_id from an explicit code lookup", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 1, name: "Aruba", code: "AW" },
        { id: 14, name: "Austria", code: "AT" },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });
    mockCreate.mockResolvedValue(44);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-code-lookup", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: { lookup: { code: "AT" } } },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "Wien Partner",
      country_id: 14,
    });
  });

  it("resolves country_id from an opaque ref", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockCreate.mockResolvedValue(45);
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.country",
      id: 14,
      label: "Austria",
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-ref", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: { ref } },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "Wien Partner",
      country_id: 14,
    });
  });

  it("rejects an opaque ref for the wrong relation model", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.partner",
      id: 7,
      label: "Wien Partner",
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-wrong-ref", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: { ref } },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("expected res.country");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("resolves USA as the United States country code instead of the first U country", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 230, name: "Uzbekistan", code: "UZ" },
        { id: 233, name: "United States", code: "US" },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });
    mockCreate.mockResolvedValue(43);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-usa", {
      model: "res.partner",
      values: { name: "US Partner", country_id: "USA" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "US Partner",
      country_id: 233,
    });
  });

  it("rejects ambiguous country text instead of creating with an arbitrary match", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 220, name: "Uganda", code: "UG" },
        { id: 230, name: "Uzbekistan", code: "UZ" },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-ambiguous", {
      model: "res.partner",
      values: { name: "Unknown Partner", country_id: "U" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Could not resolve country_id");
    expect(result.content[0].text).toContain("Uganda");
    expect(result.content[0].text).toContain("Uzbekistan");
    expect(mockCreate).not.toHaveBeenCalled();
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

  // Regression guard: some LLMs (observed with ollama-cloud/gemini-3-flash-preview
  // on the v0.5.4 staging click-through) emit tool_call arguments where the keys
  // of object-valued args contain literal JSON-escaped quotes — e.g.
  //   values: { "\"name\"": "Tesla", "\"city\"": "Wien" }
  // instead of
  //   values: { "name": "Tesla", "city": "Wien" }
  // Without sanitization those quotes reach Odoo verbatim and create() rejects
  // every record because no field "\"name\"" exists.
  it("strips literal JSON-escaped quotes from value keys before create()", async () => {
    mockCreate.mockResolvedValue(99);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-quoted-keys", {
      model: "res.partner",
      values: {
        '"name"': "Tesla Motors Austria GmbH",
        '"vat"': "ATU67878139",
        '"city"': "Wien",
        '"is_company"': true,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "Tesla Motors Austria GmbH",
      vat: "ATU67878139",
      city: "Wien",
      is_company: true,
    });
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
    expect(mockWrite).toHaveBeenCalledWith("res.partner", [1, 2], {
      email: "updated@example.com",
    });
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

  // Nested-record variant of the gemini-3-flash-preview regression: Odoo's
  // x2many command tuples wrap fresh records as `[0, 0, {…}]`, and gemini
  // applies the same quote-wrapping bug to the inner record's keys too.
  // Without recursive sanitization the outer field passes but the line never
  // materialises in Odoo, which causes a write retry loop on staging.
  it("strips quote-wrapped keys recursively from nested x2many records", async () => {
    mockWrite.mockResolvedValue(true);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;

    const result = await tool.execute("call-nested-quotes", {
      model: "res.partner",
      ids: [42],
      values: {
        '"name"': "Tesla",
        '"child_ids"': [
          [0, 0, { '"name"': "Contact 1", '"email"': "a@example.com" }],
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(mockWrite).toHaveBeenCalledWith("res.partner", [42], {
      name: "Tesla",
      child_ids: [[0, 0, { name: "Contact 1", email: "a@example.com" }]],
    });
  });

  // Same regression guard as odoo_create — see comment above the create test.
  it("strips literal JSON-escaped quotes from value keys before write()", async () => {
    mockWrite.mockResolvedValue(true);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;

    const result = await tool.execute("call-quoted-keys", {
      model: "res.partner",
      ids: [42],
      values: { '"email"': "updated@example.com", '"city"': "Linz" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockWrite).toHaveBeenCalledWith("res.partner", [42], {
      email: "updated@example.com",
      city: "Linz",
    });
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
      permissions: {
        ...testPermissions,
        "res.partner": ["read", "write", "create", "delete"],
      },
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
    mockSearchRead.mockRejectedValue(
      new Error("AccessError: no read access on sale.order"),
    );

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
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
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
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 100,
      offset: 0,
    });

    const agent2Config = {
      connectionId: "conn-test-2",
      permissions: testPermissions,
    };
    const tools = createApi({
      [agentId]: agentConfig,
      "agent-2": agent2Config,
    });

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
        credentials: {
          source: "file",
          provider: "pinchy",
          id: "/integrations/x/odooApiKey",
        },
      }),
    } as unknown as Response);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("must be a string");
    expect(text).toContain("#209");
  });

  it("invalidates the cache and refetches credentials on auth error", async () => {
    mockSearchRead.mockRejectedValueOnce(
      new Error("Access Denied: invalid api key"),
    );
    mockSearchRead.mockResolvedValueOnce({
      records: [],
      total: 0,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.isError).toBeFalsy();
    // First call fetched, error invalidated cache, second call refetched
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSearchRead).toHaveBeenCalledTimes(2);
  });
});

describe("odoo_attach_file", () => {
  const attachAgentId = "agent-attach-1";
  const attachAgentConfig = {
    connectionId: "conn-test-1",
    permissions: {
      "account.move": ["read", "write", "create"],
      "ir.attachment": ["read", "create"],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
    // Default: small file (1 KB). Override per-test for size-limit checks.
    mockStat.mockResolvedValue({ size: 1024 });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ type: "odoo", credentials: testCredentials }),
    });
  });

  it("attaches a file to a record and returns an encrypted ref", async () => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });

    const fakeBytes = Buffer.from("fake-image-bytes");
    mockReadFile.mockResolvedValue(fakeBytes);
    mockCreate.mockResolvedValue(99);

    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;
    expect(tool).not.toBeNull();

    const result = await tool.execute("call-1", {
      targetRef,
      filename: "receipt.jpg",
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.ref).toMatch(/^pinchy_ref:v1:/);
    expect(data.name).toBe("receipt.jpg");
    expect(data.mimetype).toBe("image/jpeg");

    expect(mockCreate).toHaveBeenCalledWith("ir.attachment", {
      res_model: "account.move",
      res_id: 42,
      name: "receipt.jpg",
      datas: fakeBytes.toString("base64"),
      mimetype: "image/jpeg",
    });

    expect(mockReadFile).toHaveBeenCalledWith(
      `/root/.openclaw/workspaces/${attachAgentId}/uploads/receipt.jpg`,
    );
  });

  it("returns permission denied when ir.attachment.create is missing", async () => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });

    const configNoAttach = {
      connectionId: "conn-test-1",
      permissions: {
        "account.move": ["read", "write", "create"],
        // no ir.attachment entry
      },
    };

    const tools = createApi({ [attachAgentId]: configNoAttach });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-1", {
      targetRef,
      filename: "receipt.jpg",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns permission denied when targetModel.write is missing", async () => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });

    const configReadOnly = {
      connectionId: "conn-test-1",
      permissions: {
        "account.move": ["read"],
        "ir.attachment": ["read", "create"],
      },
    };

    const tools = createApi({ [attachAgentId]: configReadOnly });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-1", {
      targetRef,
      filename: "receipt.jpg",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns an error when the file does not exist", async () => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });

    const notFound = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    mockStat.mockRejectedValue(notFound);

    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-1", {
      targetRef,
      filename: "missing.jpg",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing.jpg");
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("returns an error for an invalid targetRef", async () => {
    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-1", {
      targetRef: "not-a-valid-ref",
      filename: "receipt.jpg",
    });

    expect(result.isError).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["receipt.jpg", "image/jpeg"],
    ["scan.jpeg", "image/jpeg"],
    ["photo.png", "image/png"],
    ["anim.gif", "image/gif"],
    ["modern.webp", "image/webp"],
    ["document.pdf", "application/pdf"],
    ["unknown.xyz", "application/octet-stream"],
  ])("detects MIME type for %s as %s", async (filename, expectedMime) => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 1,
      label: "INV",
    });
    mockReadFile.mockResolvedValue(Buffer.from("bytes"));
    mockCreate.mockResolvedValue(1);

    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    await tool.execute("call-1", { targetRef, filename });

    expect(mockCreate).toHaveBeenCalledWith(
      "ir.attachment",
      expect.objectContaining({ mimetype: expectedMime }),
    );
  });

  // Security: prevents prompt-injection-driven file exfiltration. A
  // compromised agent could otherwise request `filename: "../../etc/passwd"`
  // and the plugin would attach arbitrary container files to an Odoo record.
  describe("filename validation (prevents path traversal)", () => {
    const validTargetRef = () =>
      encodeRef({
        integrationType: "odoo",
        connectionId: "conn-test-1",
        model: "account.move",
        id: 42,
        label: "INV/2025/0001",
      });

    it.each([
      ["../etc/passwd", "parent directory traversal"],
      ["../../etc/passwd", "deep parent traversal"],
      ["/etc/passwd", "absolute path"],
      ["subdir/file.txt", "subdirectory"],
      [".env", "hidden file"],
      ["..", "just dots"],
      [".", "single dot"],
      ["..\\windows\\system32", "Windows-style backslash traversal"],
    ])('rejects filename "%s" (%s)', async (badFilename) => {
      mockReadFile.mockResolvedValue(Buffer.from("bytes"));
      mockCreate.mockResolvedValue(1);

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      const result = await tool.execute("call-1", {
        targetRef: validTargetRef(),
        filename: badFilename,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/invalid filename/i);
      expect(mockStat).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("accepts a plain filename with spaces, digits, and dashes", async () => {
      mockReadFile.mockResolvedValue(Buffer.from("bytes"));
      mockCreate.mockResolvedValue(7);

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      const result = await tool.execute("call-1", {
        targetRef: validTargetRef(),
        filename: "Receipt 2026-Q1.pdf",
      });

      expect(result.isError).toBeFalsy();
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  // Defense against memory exhaustion: readFile loads the entire file plus a
  // base64 representation into memory. Without an upper bound a single
  // upload could OOM the plugin process.
  describe("file size limit", () => {
    const validTargetRef = () =>
      encodeRef({
        integrationType: "odoo",
        connectionId: "conn-test-1",
        model: "account.move",
        id: 42,
        label: "INV/2025/0001",
      });

    it("rejects files larger than 25 MB", async () => {
      mockStat.mockResolvedValue({ size: 26 * 1024 * 1024 });
      mockReadFile.mockResolvedValue(Buffer.from("bytes"));
      mockCreate.mockResolvedValue(1);

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      const result = await tool.execute("call-1", {
        targetRef: validTargetRef(),
        filename: "huge.pdf",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/too large/i);
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("accepts files at exactly 25 MB", async () => {
      mockStat.mockResolvedValue({ size: 25 * 1024 * 1024 });
      mockReadFile.mockResolvedValue(Buffer.from("bytes"));
      mockCreate.mockResolvedValue(1);

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      const result = await tool.execute("call-1", {
        targetRef: validTargetRef(),
        filename: "edge.pdf",
      });

      expect(result.isError).toBeFalsy();
      expect(mockCreate).toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch before importing the plugin
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import plugin from "../index";

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

const testConnection = {
  name: "Test Pipedrive",
  apiToken: "test-api-token",
  companyDomain: "testcompany",
};

const testPermissions: Record<string, string[]> = {
  deals: ["read", "create", "update", "delete"],
  persons: ["read", "create"],
  organizations: ["read"],
  leads: ["read", "update"],
  activities: ["read"],
};

const agentId = "agent-1";
const agentConfig = {
  connection: testConnection,
  permissions: testPermissions,
  entityNames: {
    deals: "Deals",
    persons: "Contacts",
    organizations: "Companies",
  },
};

function createApi(agentConfigs: Record<string, unknown> = {}) {
  const tools: Array<{
    factory: (ctx: { agentId?: string }) => AgentTool | null;
    name: string;
  }> = [];

  const api = {
    pluginConfig: { agents: agentConfigs },
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

function mockApiResponse(data: unknown, success = true) {
  mockFetch.mockResolvedValueOnce({
    ok: success,
    json: async () => (success ? { success: true, data } : { success: false, error: "API Error" }),
  });
}

describe("tool registration", () => {
  it("registers all 10 tools", () => {
    const tools = createApi({ [agentId]: agentConfig });
    expect(tools).toHaveLength(10);
    const names = tools.map((t) => t.name);
    expect(names).toContain("pipedrive_schema");
    expect(names).toContain("pipedrive_read");
    expect(names).toContain("pipedrive_create");
    expect(names).toContain("pipedrive_update");
    expect(names).toContain("pipedrive_delete");
    expect(names).toContain("pipedrive_search");
    expect(names).toContain("pipedrive_summary");
    expect(names).toContain("pipedrive_merge");
    expect(names).toContain("pipedrive_relate");
    expect(names).toContain("pipedrive_convert");
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

describe("pipedrive_schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists all permitted entities with display names when called without params", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_schema", agentId)!;
    expect(tool).not.toBeNull();

    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text);

    expect(data).toHaveLength(5);
    expect(data).toContainEqual({ entity: "deals", name: "Deals" });
    expect(data).toContainEqual({ entity: "persons", name: "Contacts" });
    expect(data).toContainEqual({ entity: "organizations", name: "Companies" });
    // Entities without custom names fall back to entity key
    expect(data).toContainEqual({ entity: "leads", name: "leads" });
    expect(data).toContainEqual({ entity: "activities", name: "activities" });
  });

  it("returns fields for a specific entity with a fields endpoint", async () => {
    const expectedFields = [
      { id: 1, key: "title", name: "Title", field_type: "varchar" },
      { id: 2, key: "value", name: "Value", field_type: "double" },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: expectedFields }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_schema", agentId)!;

    const result = await tool.execute("call-2", { entity: "deals" });
    const data = JSON.parse(result.content[0].text);

    expect(data.name).toBe("Deals");
    expect(data.fields).toHaveLength(2);
    expect(data.fields[0].key).toBe("title");

    // Verify the correct fields endpoint was called
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.pipedrive.com/v1/dealFields",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-token": "test-api-token" }),
      }),
    );
  });

  it("returns error for entity without fields endpoint", async () => {
    // "projects" is not in FIELDS_ENDPOINTS
    const configWithProjects = {
      ...agentConfig,
      permissions: { ...testPermissions, projects: ["read"] },
    };
    const tools = createApi({ [agentId]: configWithProjects });
    const tool = findTool(tools, "pipedrive_schema", agentId)!;

    const result = await tool.execute("call-3", { entity: "projects" });
    expect(result.content[0].text).toContain("no fields endpoint");
    expect(result.isError).toBe(true);
  });

  it("denies access to unpermitted entity", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_schema", agentId)!;

    const result = await tool.execute("call-4", { entity: "products" });
    expect(result.content[0].text).toContain("not available");
    expect(result.isError).toBe(true);
  });
});

describe("pipedrive_read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads entities using v2 endpoint for v2 entities", async () => {
    const responseData = [
      { id: 1, title: "Big Deal", value: 5000 },
      { id: 2, title: "Small Deal", value: 100 },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: responseData,
        additional_data: { next_cursor: "abc123" },
      }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_read", agentId)!;

    const result = await tool.execute("call-1", {
      entity: "deals",
      limit: 10,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.data).toHaveLength(2);
    expect(data.additional_data.next_cursor).toBe("abc123");

    // Should use v2 for deals
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v2/deals");
  });

  it("reads entities using v1 endpoint for v1 entities", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: [{ id: 1, title: "Lead 1" }] }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_read", agentId)!;

    const result = await tool.execute("call-2", {
      entity: "leads",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/leads");
    expect(result.isError).toBeUndefined();
  });

  it("denies read on unpermitted entity", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_read", agentId)!;

    const result = await tool.execute("call-3", {
      entity: "products",
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("products");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("pipedrive_create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an entity with correct parameters", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { id: 42, title: "New Deal" } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_create", agentId)!;

    const result = await tool.execute("call-1", {
      entity: "deals",
      data: { title: "New Deal", value: 1000 },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.data.id).toBe(42);

    // Verify POST was called with correct body
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/deals"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "New Deal", value: 1000 }),
      }),
    );
  });

  it("denies create on entity without create permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_create", agentId)!;

    const result = await tool.execute("call-2", {
      entity: "organizations",
      data: { name: "Test Org" },
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("create");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("pipedrive_update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates an entity with correct parameters", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { id: 1, title: "Updated Deal" },
      }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_update", agentId)!;

    const result = await tool.execute("call-1", {
      entity: "deals",
      id: 1,
      data: { title: "Updated Deal" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.data.id).toBe(1);

    // Verify PATCH was called
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/deals/1"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Updated Deal" }),
      }),
    );
  });

  it("denies update on entity without update permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_update", agentId)!;

    const result = await tool.execute("call-2", {
      entity: "organizations",
      id: 1,
      data: { name: "Updated" },
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("pipedrive_delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes an entity", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { id: 1 } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_delete", agentId)!;

    const result = await tool.execute("call-1", {
      entity: "deals",
      id: 1,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.data.id).toBe(1);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/deals/1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("denies delete on entity without delete permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_delete", agentId)!;

    // persons only has read+create, not delete
    const result = await tool.execute("call-2", {
      entity: "persons",
      id: 1,
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("pipedrive_search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches with permitted entity types", async () => {
    const searchResults = [
      { type: "deal", item: { id: 1, title: "Big Deal" } },
      { type: "person", item: { id: 2, name: "John" } },
      { type: "product", item: { id: 3, name: "Widget" } },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { items: searchResults } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_search", agentId)!;

    const result = await tool.execute("call-1", {
      term: "Big",
    });

    const data = JSON.parse(result.content[0].text);
    // "product" type should be filtered out since agent has no products permission
    expect(data.items).toHaveLength(2);
    expect(data.items.map((i: { type: string }) => i.type)).toEqual(["deal", "person"]);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v2/itemSearch");
    expect(calledUrl).toContain("term=Big");
  });

  it("filters by specified entity types", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { items: [{ type: "deal", item: { id: 1, title: "Deal" } }] },
      }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_search", agentId)!;

    await tool.execute("call-2", {
      term: "test",
      entity_types: ["deal"],
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("item_types=deal");
  });
});

describe("pipedrive_summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gets deals summary", async () => {
    const summaryData = {
      total_count: 50,
      total_currency_converted_value: 150000,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: summaryData }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_summary", agentId)!;

    const result = await tool.execute("call-1", {
      type: "deals_summary",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.data.total_count).toBe(50);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/deals/summary");
  });

  it("gets pipeline conversion statistics", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { won_count: 10 } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_summary", agentId)!;

    const result = await tool.execute("call-2", {
      type: "pipeline_conversion",
      pipeline_id: 1,
    });

    expect(result.isError).toBeUndefined();
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/pipelines/1/conversion_statistics");
  });

  it("gets pipeline movement statistics", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { movements: [] } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_summary", agentId)!;

    await tool.execute("call-3", {
      type: "pipeline_movement",
      pipeline_id: 2,
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/pipelines/2/movement_statistics");
  });

  it("requires pipeline_id for conversion and movement stats", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_summary", agentId)!;

    const result = await tool.execute("call-4", {
      type: "pipeline_conversion",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pipeline_id");
  });

  it("denies summary without deals read permission", async () => {
    const configNoDealRead = {
      ...agentConfig,
      permissions: { persons: ["read"] },
    };
    const tools = createApi({ [agentId]: configNoDealRead });
    const tool = findTool(tools, "pipedrive_summary", agentId)!;

    const result = await tool.execute("call-5", {
      type: "deals_summary",
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
  });
});

describe("pipedrive_merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges two deals", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { id: 1, merge_with_id: 2 } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_merge", agentId)!;

    const result = await tool.execute("call-1", {
      entity: "deals",
      id: 1,
      merge_with_id: 2,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.data.id).toBe(1);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/deals/1/merge"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ merge_with_id: 2 }),
      }),
    );
  });

  it("requires both update and delete permissions for merge", async () => {
    // persons only has read+create, not update+delete
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_merge", agentId)!;

    const result = await tool.execute("call-2", {
      entity: "persons",
      id: 1,
      merge_with_id: 2,
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("pipedrive_relate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a product to a deal", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { id: 1 } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_relate", agentId)!;

    const result = await tool.execute("call-1", {
      action: "add_product",
      deal_id: 1,
      product_id: 10,
      quantity: 2,
      price: 99.99,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.data.id).toBe(1);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/deals/1/products"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ product_id: 10, quantity: 2, item_price: 99.99 }),
      }),
    );
  });

  it("removes a product from a deal", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_relate", agentId)!;

    await tool.execute("call-2", {
      action: "remove_product",
      deal_id: 1,
      attachment_id: 5,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/deals/1/products/5"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("adds a participant to a deal", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { id: 1 } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_relate", agentId)!;

    await tool.execute("call-3", {
      action: "add_participant",
      deal_id: 1,
      person_id: 42,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/deals/1/participants"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ person_id: 42 }),
      }),
    );
  });

  it("removes a participant from a deal", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_relate", agentId)!;

    await tool.execute("call-4", {
      action: "remove_participant",
      deal_id: 1,
      participant_id: 7,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/deals/1/participants/7"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("adds a follower to an entity", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { id: 1 } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_relate", agentId)!;

    await tool.execute("call-5", {
      action: "add_follower",
      entity: "deals",
      id: 1,
      user_id: 5,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/deals/1/followers"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: 5 }),
      }),
    );
  });

  it("removes a follower from an entity", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_relate", agentId)!;

    await tool.execute("call-6", {
      action: "remove_follower",
      entity: "deals",
      id: 1,
      follower_id: 5,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/deals/1/followers/5"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("denies relate without update permission on target entity", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_relate", agentId)!;

    // organizations only has "read", not "update"
    const result = await tool.execute("call-7", {
      action: "add_follower",
      entity: "organizations",
      id: 1,
      user_id: 5,
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("pipedrive_convert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts a lead to a deal", async () => {
    // First call: POST to convert (returns 202 with polling URL)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { deal_id: 42 } }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_convert", agentId)!;

    const result = await tool.execute("call-1", {
      direction: "lead_to_deal",
      id: 10,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.data.deal_id).toBe(42);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v2/leads/10/convert/deal"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("converts a deal to a lead", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { lead_id: "abc" } }),
    });

    // Need create on leads (target) + update on deals (source)
    const convertConfig = {
      ...agentConfig,
      permissions: {
        ...testPermissions,
        leads: ["read", "update", "create"],
      },
    };
    const tools = createApi({ [agentId]: convertConfig });
    const tool = findTool(tools, "pipedrive_convert", agentId)!;

    const result = await tool.execute("call-2", {
      direction: "deal_to_lead",
      id: 5,
    });

    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v2/deals/5/convert/lead"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("requires create on target entity and update on source entity for lead_to_deal", async () => {
    // Config with leads read only, no deals create
    const restrictedConfig = {
      ...agentConfig,
      permissions: { leads: ["read"], deals: ["read"] },
    };
    const tools = createApi({ [agentId]: restrictedConfig });
    const tool = findTool(tools, "pipedrive_convert", agentId)!;

    const result = await tool.execute("call-3", {
      direction: "lead_to_deal",
      id: 10,
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("requires create on leads and update on deals for deal_to_lead", async () => {
    // Config with deals but no leads create
    const restrictedConfig = {
      ...agentConfig,
      permissions: { deals: ["read", "update"], leads: ["read"] },
    };
    const tools = createApi({ [agentId]: restrictedConfig });
    const tool = findTool(tools, "pipedrive_convert", agentId)!;

    const result = await tool.execute("call-4", {
      direction: "deal_to_lead",
      id: 5,
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error message when API returns unsuccessful response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ success: false, error: "Unauthorized" }),
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_read", agentId)!;

    const result = await tool.execute("call-1", {
      entity: "deals",
    });

    expect(result.content[0].text).toContain("Unauthorized");
    expect(result.isError).toBe(true);
  });

  it("returns error message when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_read", agentId)!;

    const result = await tool.execute("call-2", {
      entity: "deals",
    });

    expect(result.content[0].text).toContain("Error: Network error");
    expect(result.isError).toBe(true);
  });

  it("handles non-Error throws gracefully", async () => {
    mockFetch.mockRejectedValueOnce("string error");

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "pipedrive_read", agentId)!;

    const result = await tool.execute("call-3", {
      entity: "deals",
    });

    expect(result.content[0].text).toContain("Unknown error");
    expect(result.isError).toBe(true);
  });
});

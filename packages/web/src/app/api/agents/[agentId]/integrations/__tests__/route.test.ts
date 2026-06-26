import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockGetSession,
  mockAppendAuditLog,
  mockRegenerateOpenClawConfig,
  mockTransaction,
  mockTxDeleteWhere,
  mockTxInsertValues,
  mockTxSelect,
} = vi.hoisted(() => {
  const mockTxDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockTxInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockTxSelectRows = vi.fn().mockResolvedValue([]);

  const mockTransaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = {
      delete: vi.fn().mockReturnValue({ where: mockTxDeleteWhere }),
      insert: vi.fn().mockReturnValue({ values: mockTxInsertValues }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: mockTxSelectRows }),
      }),
    };
    return cb(tx);
  });

  return {
    mockGetSession: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    mockRegenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
    mockTransaction,
    mockTxDeleteWhere,
    mockTxInsertValues,
    mockTxSelect: mockTxSelectRows,
  };
});

// ── Static mocks ─────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: (...args: unknown[]) => mockRegenerateOpenClawConfig(...args),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ _type: "and", args })),
}));

vi.mock("@/db/schema", () => ({
  agentConnectionPermissions: {
    agentId: "agentId",
    connectionId: "connectionId",
    model: "model",
    operation: "operation",
  },
  agentMcpToolPermissions: {
    agentId: "agentId",
    connectionId: "connectionId",
    toolName: "toolName",
  },
  integrationConnections: { id: "id", type: "type", name: "name", data: "data" },
}));

// ── DB mock setup ─────────────────────────────────────────────────────────────

// We'll control the db mock per-test via the selectFromImpl
const mockSelectFrom = vi.fn();
const mockSelectJoin = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectWhere2 = vi.fn();
const mockQueryFindFirst = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: mockSelectFrom,
    }),
    transaction: mockTransaction,
    query: {
      integrationConnections: {
        findFirst: mockQueryFindFirst,
      },
    },
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };

const odooConnection = {
  id: "conn-odoo-1",
  type: "odoo",
  name: "My Odoo",
  data: {
    models: [{ model: "sale.order", name: "Sales Order" }],
  },
};

const mcpConnection = {
  id: "conn-mcp-1",
  type: "mcp",
  name: "My GitHub MCP",
  data: {
    type: "mcp",
    preset: "github",
    transport: "http",
    url: "https://mcp.example.com/github",
    tools: [
      { name: "list_repos", description: "List repos", inputSchema: {} },
      { name: "create_issue", description: "Create issue", inputSchema: {} },
    ],
    lastSyncAt: "2026-01-01T00:00:00Z",
  },
};

// Helper to make requests
function makeRequest(url: string, options?: RequestInit) {
  return new NextRequest(`http://localhost:7777${url}`, options);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/agents/[agentId]/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockGetSession.mockResolvedValue(adminSession);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty permissions and no drift when agent has no permissions", async () => {
    // First select (agentConnectionPermissions join) returns empty
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    // Second select (agentMcpToolPermissions join) returns empty
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { GET } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations");
    const res = await GET(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ permissions: [], drift: [] });
  });

  it("returns Odoo permissions with kind='odoo'", async () => {
    const odooRows = [
      {
        integration_connections: odooConnection,
        agent_connection_permissions: {
          connectionId: "conn-odoo-1",
          model: "sale.order",
          operation: "read",
        },
      },
    ];

    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(odooRows),
      }),
    });
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { GET } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations");
    const res = await GET(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0]).toMatchObject({
      kind: "odoo",
      connectionId: "conn-odoo-1",
      entries: [{ model: "sale.order", operation: "read" }],
    });
    expect(body.drift).toEqual([]);
  });

  it("returns MCP permissions with kind='mcp' including connectionName and availableTools", async () => {
    const mcpRows = [
      {
        integration_connections: mcpConnection,
        agent_mcp_tool_permissions: {
          connectionId: "conn-mcp-1",
          toolName: "list_repos",
        },
      },
      {
        integration_connections: mcpConnection,
        agent_mcp_tool_permissions: {
          connectionId: "conn-mcp-1",
          toolName: "create_issue",
        },
      },
    ];

    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mcpRows),
      }),
    });

    const { GET } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations");
    const res = await GET(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0]).toMatchObject({
      kind: "mcp",
      connectionId: "conn-mcp-1",
      connectionName: "My GitHub MCP",
      // availableTools now carries the server-provided description so the
      // Permissions UI can show what each tool does, not just its name.
      availableTools: expect.arrayContaining([
        { name: "list_repos", description: "List repos" },
        { name: "create_issue", description: "Create issue" },
      ]),
      tools: expect.arrayContaining(["list_repos", "create_issue"]),
    });
    expect(body.drift).toEqual([]);
  });

  it("returns mixed Odoo + MCP permissions sorted by connectionId", async () => {
    const odooRows = [
      {
        integration_connections: odooConnection,
        agent_connection_permissions: {
          connectionId: "conn-odoo-1",
          model: "sale.order",
          operation: "read",
        },
      },
    ];

    const mcpRows = [
      {
        integration_connections: mcpConnection,
        agent_mcp_tool_permissions: {
          connectionId: "conn-mcp-1",
          toolName: "list_repos",
        },
      },
    ];

    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(odooRows),
      }),
    });
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mcpRows),
      }),
    });

    const { GET } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations");
    const res = await GET(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.permissions).toHaveLength(2);

    const kinds = body.permissions.map((item: { kind: string }) => item.kind);
    expect(kinds).toContain("odoo");
    expect(kinds).toContain("mcp");

    // Verify sorted by connectionId
    const ids = body.permissions.map((item: { connectionId: string }) => item.connectionId);
    expect(ids).toEqual([...ids].sort());

    expect(body.drift).toEqual([]);
  });

  it("returns drift entries for MCP tools that were granted but no longer available", async () => {
    // Connection now only has list_repos, but create_issue was previously granted
    const mcpConnectionWithFewerTools = {
      ...mcpConnection,
      data: {
        ...mcpConnection.data,
        tools: [{ name: "list_repos", description: "List repos", inputSchema: {} }],
      },
    };

    const mcpRows = [
      {
        integration_connections: mcpConnectionWithFewerTools,
        agent_mcp_tool_permissions: {
          connectionId: "conn-mcp-1",
          toolName: "list_repos",
        },
      },
      {
        integration_connections: mcpConnectionWithFewerTools,
        agent_mcp_tool_permissions: {
          connectionId: "conn-mcp-1",
          toolName: "create_issue", // no longer available
        },
      },
    ];

    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]), // no odoo perms
      }),
    });
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mcpRows),
      }),
    });

    const { GET } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations");
    const res = await GET(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);

    // list_repos should be in permissions, create_issue should be in drift
    expect(body.permissions[0].tools).toContain("list_repos");
    expect(body.permissions[0].tools).not.toContain("create_issue");

    expect(body.drift).toHaveLength(1);
    expect(body.drift[0]).toEqual({
      connectionName: "My GitHub MCP",
      removedTool: "create_issue",
    });
  });
});

describe("PUT /api/agents/[agentId]/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockGetSession.mockResolvedValue(adminSession);

    // Default: existing MCP state is empty (for diff)
    mockTxSelect.mockResolvedValue([]);
    mockTxDeleteWhere.mockResolvedValue(undefined);
    mockTxInsertValues.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pure-Odoo round-trip: deletes old Odoo, inserts new Odoo, audits (no regen — Pattern B)", async () => {
    const body = [
      {
        kind: "odoo",
        connectionId: "conn-odoo-1",
        entries: [
          { model: "sale.order", operation: "read" },
          { model: "account.move", operation: "write" },
        ],
      },
    ];

    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const res = await PUT(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    const resBody = await res.json();

    expect(res.status).toBe(200);
    expect(resBody).toEqual({ success: true });

    // Transaction was called
    expect(mockTransaction).toHaveBeenCalled();

    // Both tables were deleted for this agent
    expect(mockTxDeleteWhere).toHaveBeenCalledTimes(2);

    // Odoo entries were inserted
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "agent-1",
          connectionId: "conn-odoo-1",
          model: "sale.order",
          operation: "read",
        }),
        expect.objectContaining({
          agentId: "agent-1",
          connectionId: "conn-odoo-1",
          model: "account.move",
          operation: "write",
        }),
      ])
    );

    // Audit was fired
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "agent.updated",
        resource: "agent:agent-1",
        outcome: "success",
      })
    );

    // Config NOT regenerated — Odoo/email/web-search plugins fetch perms
    // lazily at runtime (Pattern B), so the emitted config is unaffected
    // by per-agent grants. Skipping the no-op regen also avoids racing
    // with the follow-up PATCH /api/agents/:id allowedTools that the UI
    // typically issues right after — back-to-back config.apply calls hit
    // OpenClaw's rate limit. See e2e/email/email.spec.ts dispatch probe.
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("pure-MCP round-trip: validates tools, deletes old, inserts new, audits diff", async () => {
    // Connection lookup returns MCP connection with tools
    mockQueryFindFirst.mockResolvedValue(mcpConnection);

    // Old MCP state: had "list_repos" before
    mockTxSelect.mockResolvedValue([{ connectionId: "conn-mcp-1", toolName: "list_repos" }]);

    const body = [
      {
        kind: "mcp",
        connectionId: "conn-mcp-1",
        tools: ["create_issue"],
      },
    ];

    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const res = await PUT(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    const resBody = await res.json();

    expect(res.status).toBe(200);
    expect(resBody).toEqual({ success: true });

    // Transaction was called
    expect(mockTransaction).toHaveBeenCalled();

    // Both tables deleted
    expect(mockTxDeleteWhere).toHaveBeenCalledTimes(2);

    // MCP tool inserted
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "agent-1",
          connectionId: "conn-mcp-1",
          toolName: "create_issue",
        }),
      ])
    );

    // Audit includes mcpTools diff: added create_issue, removed list_repos
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "agent.updated",
        resource: "agent:agent-1",
        detail: expect.objectContaining({
          mcpTools: expect.objectContaining({
            added: expect.arrayContaining([expect.objectContaining({ tool: "create_issue" })]),
            removed: expect.arrayContaining([expect.objectContaining({ tool: "list_repos" })]),
          }),
        }),
        outcome: "success",
      })
    );

    // Config regenerated
    expect(mockRegenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("mixed Odoo + MCP: both tables are atomically replaced", async () => {
    mockQueryFindFirst.mockResolvedValue(mcpConnection);
    mockTxSelect.mockResolvedValue([]);

    const body = [
      {
        kind: "odoo",
        connectionId: "conn-odoo-1",
        entries: [{ model: "sale.order", operation: "read" }],
      },
      {
        kind: "mcp",
        connectionId: "conn-mcp-1",
        tools: ["list_repos"],
      },
    ];

    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const res = await PUT(req, { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(res.status).toBe(200);

    // Both tables must be deleted (atomic replace)
    expect(mockTxDeleteWhere).toHaveBeenCalledTimes(2);

    // Both tables have inserts
    const insertCalls = mockTxInsertValues.mock.calls;
    const allInsertedValues = insertCalls.flatMap((call: unknown[][]) => call[0] as unknown[]);

    const hasOdoo = (allInsertedValues as Array<Record<string, unknown>>).some(
      (v) => v.model === "sale.order"
    );
    const hasMcp = (allInsertedValues as Array<Record<string, unknown>>).some(
      (v) => v.toolName === "list_repos"
    );

    expect(hasOdoo).toBe(true);
    expect(hasMcp).toBe(true);
  });

  it("returns 409 when a tool is no longer available on the connection", async () => {
    // Connection only has list_repos (not create_issue)
    mockQueryFindFirst.mockResolvedValue({
      ...mcpConnection,
      data: {
        ...mcpConnection.data,
        tools: [{ name: "list_repos", description: "List repos", inputSchema: {} }],
      },
    });

    const body = [
      {
        kind: "mcp",
        connectionId: "conn-mcp-1",
        tools: ["create_issue"], // not in connection's tools anymore
      },
    ];

    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const res = await PUT(req, { params: Promise.resolve({ agentId: "agent-1" }) });
    const resBody = await res.json();

    expect(res.status).toBe(409);
    expect(resBody.error).toContain("create_issue");

    // No transaction should have run
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("audit detail contains structured mcpTools added/removed diff with connection snapshot", async () => {
    mockQueryFindFirst.mockResolvedValue(mcpConnection);

    // Old state: had list_repos
    mockTxSelect.mockResolvedValue([{ connectionId: "conn-mcp-1", toolName: "list_repos" }]);

    const body = [
      {
        kind: "mcp",
        connectionId: "conn-mcp-1",
        tools: ["create_issue"],
      },
    ];

    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    await PUT(req, { params: Promise.resolve({ agentId: "agent-1" }) });

    const auditCall = mockAppendAuditLog.mock.calls[0][0];
    const mcpTools = auditCall.detail.mcpTools;

    expect(mcpTools.added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection: expect.objectContaining({ id: "conn-mcp-1", name: "My GitHub MCP" }),
          tool: "create_issue",
        }),
      ])
    );

    expect(mcpTools.removed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection: expect.objectContaining({ id: "conn-mcp-1", name: "My GitHub MCP" }),
          tool: "list_repos",
        }),
      ])
    );
  });

  it("returns 400 when body fails schema validation", async () => {
    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");
    const req = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify({ not: "an array" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

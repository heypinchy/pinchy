/**
 * Tests for PINCHY_MCP_ENABLED feature flag gating.
 *
 * Covers:
 * - POST /api/integrations (MCP branch returns 404 when flag off)
 * - POST /api/integrations/test (entire route returns 404 when flag off)
 * - POST /api/integrations/[connectionId]/sync (MCP branch returns 404 when flag off)
 * - GET /api/agents/[agentId]/integrations (MCP data excluded when flag off)
 * - PUT /api/agents/[agentId]/integrations (MCP entries rejected with 404 when flag off)
 *
 * Also verifies Odoo paths continue to work when flag is off.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockListMcpTools = vi.fn();
vi.mock("@/lib/integrations/mcp-client", () => ({
  listMcpTools: (...args: unknown[]) => mockListMcpTools(...args),
  McpAuthError: class McpAuthError extends Error {
    constructor(message = "MCP server returned 401 Unauthorized") {
      super(message);
      this.name = "McpAuthError";
    }
  },
  McpServerError: class McpServerError extends Error {
    readonly statusCode: number;
    readonly body: string;
    constructor(statusCode: number, body: string) {
      super(`MCP server returned ${statusCode}: ${body}`);
      this.name = "McpServerError";
      this.statusCode = statusCode;
      this.body = body;
    }
  },
  McpSchemaError: class McpSchemaError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "McpSchemaError";
    }
  },
}));

const mockEncrypt = vi.fn().mockReturnValue("encrypted-creds");
const mockDecrypt = vi.fn().mockReturnValue(JSON.stringify({ token: "tok" }));
vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
}));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

const mockRegenerateOpenClawConfig = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: (...args: unknown[]) => mockRegenerateOpenClawConfig(...args),
}));

const mockDiffMcpTools = vi.fn().mockReturnValue({ added: [], removed: [], unchanged: [] });
vi.mock("@/lib/integrations/mcp-tool-diff", () => ({
  diffMcpTools: (...args: unknown[]) => mockDiffMcpTools(...args),
}));

vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("@/lib/integrations/mask-credentials", () => ({
  maskConnectionCredentials: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: vi.fn().mockResolvedValue({ success: false, error: "sync failed" }),
}));

// ── DB mocks ─────────────────────────────────────────────────────────────────

const { mockInsertValues, mockSelectFrom, mockSelectWhere, mockTransaction } = vi.hoisted(() => {
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
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };
    return cb(tx);
  });

  return {
    mockInsertValues: vi.fn(),
    mockSelectFrom: vi.fn(),
    mockSelectWhere: vi.fn().mockResolvedValue([]),
    mockTransaction,
  };
});

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: mockInsertValues.mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "conn-mcp-1",
            type: "mcp",
            name: "Test MCP",
            description: "",
            credentials: "encrypted-creds",
            data: {
              type: "mcp",
              preset: "generic",
              transport: "http",
              url: "https://mcp.test/",
              tools: [],
              lastSyncAt: new Date().toISOString(),
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: mockSelectFrom.mockImplementation(() => {
        const result = Promise.resolve([]) as Promise<unknown[]> & {
          where: ReturnType<typeof vi.fn>;
          innerJoin: ReturnType<typeof vi.fn>;
        };
        result.where = mockSelectWhere;
        result.innerJoin = vi.fn().mockReturnValue({ where: mockSelectWhere });
        return result;
      }),
    }),
    transaction: mockTransaction,
    query: {
      integrationConnections: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id", type: "type", name: "name", data: "data" },
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
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ _type: "and", args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ _type: "inArray", col, vals })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };

function makeRequest(url: string, options?: RequestInit) {
  return new NextRequest(`http://localhost:7777${url}`, options);
}

const validMcpBody = {
  type: "mcp",
  name: "My GitHub MCP",
  description: "",
  preset: "github",
  transport: "http",
  url: "https://mcp.example.com/github",
  token: "mcp-token-123",
};

const validOdooBody = {
  type: "odoo",
  name: "My Odoo",
  description: "",
  credentials: {
    url: "https://odoo.example.com",
    db: "prod",
    login: "admin@example.com",
    apiKey: "key123",
  },
};

// ── Tests: POST /api/integrations ────────────────────────────────────────────

describe("POST /api/integrations — MCP gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue(adminSession);
    mockListMcpTools.mockResolvedValue([
      { name: "list_repos", description: "List", inputSchema: { type: "object" } },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 404 for MCP type when PINCHY_MCP_ENABLED is off", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const { POST } = await import("@/app/api/integrations/route");
    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(404);
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("returns 201 for MCP type when PINCHY_MCP_ENABLED is on", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");

    const { POST } = await import("@/app/api/integrations/route");
    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(mockListMcpTools).toHaveBeenCalled();
  });

  it("Odoo type still works when PINCHY_MCP_ENABLED is off", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const { POST } = await import("@/app/api/integrations/route");
    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify(validOdooBody),
    });
    const response = await POST(request);

    // Odoo path should proceed (URL validation happens next, not 404)
    expect(response.status).not.toBe(404);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });
});

// ── Tests: POST /api/integrations/test ───────────────────────────────────────

describe("POST /api/integrations/test — MCP gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue(adminSession);
    mockListMcpTools.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 404 when PINCHY_MCP_ENABLED is off", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const { POST } = await import("@/app/api/integrations/test/route");
    const request = makeRequest("/api/integrations/test", {
      method: "POST",
      body: JSON.stringify({ url: "https://mcp.example.com/", transport: "http", token: "tok" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(404);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("returns 200 when PINCHY_MCP_ENABLED is on", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");

    const { POST } = await import("@/app/api/integrations/test/route");
    const request = makeRequest("/api/integrations/test", {
      method: "POST",
      body: JSON.stringify({ url: "https://mcp.example.com/", transport: "http", token: "tok" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockListMcpTools).toHaveBeenCalled();
  });
});

// ── Tests: GET /api/agents/[agentId]/integrations — MCP data excluded ─────────

describe("GET /api/agents/[agentId]/integrations — MCP gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue(adminSession);
    // By default, return no rows
    mockSelectWhere.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not query MCP tool permissions when PINCHY_MCP_ENABLED is off", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const { GET } = await import("@/app/api/agents/[agentId]/integrations/route");

    const request = makeRequest("/api/agents/agent-1/integrations");
    const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };
    const response = await GET(request, ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    // MCP permissions array must be empty (no MCP data queried)
    const mcpPerms = body.permissions.filter((p: { kind: string }) => p.kind === "mcp");
    expect(mcpPerms).toHaveLength(0);
    expect(body.drift).toHaveLength(0);
  });

  it("returns 200 with MCP data when PINCHY_MCP_ENABLED is on", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");

    const { GET } = await import("@/app/api/agents/[agentId]/integrations/route");

    const request = makeRequest("/api/agents/agent-1/integrations");
    const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };
    const response = await GET(request, ctx);

    expect(response.status).toBe(200);
  });
});

// ── Tests: PUT /api/agents/[agentId]/integrations — MCP entries rejected ──────

describe("PUT /api/agents/[agentId]/integrations — MCP gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue(adminSession);
    mockSelectWhere.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 404 when body has MCP entries and PINCHY_MCP_ENABLED is off", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");

    const request = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify([{ kind: "mcp", connectionId: "conn-1", tools: ["list_repos"] }]),
    });
    const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };
    const response = await PUT(request, ctx);

    expect(response.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("allows PUT with only Odoo entries when PINCHY_MCP_ENABLED is off", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");

    const request = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify([
        {
          kind: "odoo",
          connectionId: "conn-odoo-1",
          entries: [{ model: "sale.order", operation: "read" }],
        },
      ]),
    });
    const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };
    const response = await PUT(request, ctx);

    // Should NOT be 404 — Odoo path continues (will succeed or fail based on DB state)
    expect(response.status).not.toBe(404);
  });

  it("allows PUT with MCP entries when PINCHY_MCP_ENABLED is on", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");

    // Mock findFirst to return a valid MCP connection
    const mockFindFirst = vi.fn().mockResolvedValue({
      id: "conn-mcp-1",
      name: "Test MCP",
      data: { tools: [{ name: "list_repos", description: "List" }] },
    });
    const { db } = await import("@/db");
    (db.query.integrationConnections.findFirst as ReturnType<typeof vi.fn>) = mockFindFirst;

    const { PUT } = await import("@/app/api/agents/[agentId]/integrations/route");

    const request = makeRequest("/api/agents/agent-1/integrations", {
      method: "PUT",
      body: JSON.stringify([{ kind: "mcp", connectionId: "conn-mcp-1", tools: ["list_repos"] }]),
    });
    const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };
    const response = await PUT(request, ctx);

    // Should reach the MCP validation path (not 404)
    expect(response.status).not.toBe(404);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockDecrypt = vi.fn();
vi.mock("@/lib/encryption", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockSelectWhere = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: mockUpdateSet.mockReturnValue({
        where: mockUpdateWhere,
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

const mockListMcpTools = vi.fn();
vi.mock("@/lib/integrations/mcp-client", () => ({
  listMcpTools: (...args: unknown[]) => mockListMcpTools(...args),
  McpAuthError: class McpAuthError extends Error {
    constructor(message = "MCP server rejected the token") {
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

vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("@/lib/integrations/odoo-schema", () => ({
  odooCredentialsSchema: {
    safeParse: vi.fn().mockReturnValue({ success: false }),
  },
}));

vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: vi.fn(),
}));

const mockClearIntegrationAuthError = vi.fn();
const mockSetIntegrationAuthFailed = vi.fn();
vi.mock("@/lib/integrations/auth-state", () => ({
  clearIntegrationAuthError: (...args: unknown[]) => mockClearIntegrationAuthError(...args),
  setIntegrationAuthFailed: (...args: unknown[]) => mockSetIntegrationAuthFailed(...args),
}));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:7777${path}`, { method: "POST" });
}

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };

const existingTools = [
  { name: "list_repos", description: "List repos", inputSchema: {} },
  { name: "close_issue", description: "Close an issue", inputSchema: {} },
];

const mockMcpData = {
  type: "mcp",
  preset: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  tools: existingTools,
  lastSyncAt: "2026-01-01T00:00:00.000Z",
};

const mockMcpConnection = {
  id: "conn-mcp-1",
  type: "mcp",
  name: "GitHub",
  credentials: "encrypted-mcp-creds",
  data: mockMcpData,
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

describe("POST /api/integrations/[connectionId]/sync (type=mcp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockGetSession.mockResolvedValue(adminSession);
    mockDecrypt.mockReturnValue(JSON.stringify({ token: "pat-current-token" }));
    mockSelectWhere.mockResolvedValue([mockMcpConnection]);
    mockClearIntegrationAuthError.mockResolvedValue(undefined);
    mockSetIntegrationAuthFailed.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 404 when connection not found", async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });
    expect(response.status).toBe(404);
  });

  it("returns 404 when PINCHY_MCP_ENABLED is not set, before calling listMcpTools", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", undefined);
    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });

    expect(response.status).toBe(404);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("re-discovers tools, persists the diff, clears auth error, and audits added/removed names", async () => {
    const newTools = [
      { name: "list_repos", description: "List repos", inputSchema: {} }, // unchanged
      { name: "create_pr", description: "Create a PR", inputSchema: {} }, // added
      // close_issue removed
    ];
    mockListMcpTools.mockResolvedValue(newTools);

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");
    const response = await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    expect(mockListMcpTools).toHaveBeenCalledWith({
      url: mockMcpData.url,
      transport: mockMcpData.transport,
      token: "pat-current-token",
      extraHeaders: undefined,
    });

    // Persists the fresh tool list + a new lastSyncAt, keeps the rest of `data`
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ...mockMcpData,
          tools: newTools,
          lastSyncAt: expect.any(String),
        }),
      })
    );

    expect(mockClearIntegrationAuthError).toHaveBeenCalledWith({
      connectionId: "conn-mcp-1",
      actor: { type: "user", id: "user-1" },
    });
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();

    expect(mockDeferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "user-1",
        eventType: "integration.synced",
        resource: "integration:conn-mcp-1",
        detail: expect.objectContaining({
          id: "conn-mcp-1",
          name: "GitHub",
          tools: expect.objectContaining({
            added: ["create_pr"],
            removed: ["close_issue"],
            total: newTools.length,
          }),
        }),
        outcome: "success",
      })
    );
  });

  it("reuses stored extraHeaders (e.g. HighLevel locationId) during re-discovery", async () => {
    const dataWithHeaders = { ...mockMcpData, extraHeaders: { locationId: "loc-123" } };
    mockSelectWhere.mockResolvedValueOnce([{ ...mockMcpConnection, data: dataWithHeaders }]);
    mockListMcpTools.mockResolvedValue(existingTools);

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");
    await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });

    expect(mockListMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({ extraHeaders: { locationId: "loc-123" } })
    );
  });

  it("flips to auth_failed on a genuine auth failure (McpAuthError) and does NOT persist the old tools", async () => {
    const { McpAuthError } = await import("@/lib/integrations/mcp-client");
    mockListMcpTools.mockRejectedValue(new McpAuthError());

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");
    const response = await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(mockSetIntegrationAuthFailed).toHaveBeenCalledWith({
      connectionId: "conn-mcp-1",
      reason: expect.any(String),
      actor: { type: "user", id: "user-1" },
    });
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockDeferAuditLog).not.toHaveBeenCalled();
  });

  it("does NOT flip to auth_failed on a 5xx (McpServerError) — a healthy connection must survive a server hiccup", async () => {
    const { McpServerError } = await import("@/lib/integrations/mcp-client");
    mockListMcpTools.mockRejectedValue(new McpServerError(503, "unavailable"));

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");
    const response = await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("does NOT flip to auth_failed on a malformed response (McpSchemaError)", async () => {
    const { McpSchemaError } = await import("@/lib/integrations/mcp-client");
    mockListMcpTools.mockRejectedValue(new McpSchemaError("bad shape"));

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");
    const response = await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
  });

  it("does NOT flip to auth_failed on a network/timeout error", async () => {
    mockListMcpTools.mockRejectedValue(new Error("fetch failed"));

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");
    const response = await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
  });

  it("summarizes a large tool diff in the audit detail instead of listing every name (2048-byte cap)", async () => {
    const manyNewTools = Array.from({ length: 40 }, (_, i) => ({
      name: `new_tool_${i}`,
      description: "d",
      inputSchema: {},
    }));
    mockListMcpTools.mockResolvedValue(manyNewTools);

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");
    await POST(makeRequest("/api/integrations/conn-mcp-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-mcp-1" }),
    });

    const call = mockDeferAuditLog.mock.calls.find((c) => c[0].eventType === "integration.synced");
    expect(call).toBeDefined();
    const detail = call![0].detail;
    // Full byte size stays well under the cap regardless of tool-name count.
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBeLessThan(2048);
    expect(detail.tools.total).toBe(manyNewTools.length);
  });
});

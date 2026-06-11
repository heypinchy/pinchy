import { describe, it, expect, vi, beforeEach } from "vitest";
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

const mockEncrypt = vi.fn().mockReturnValue("encrypted-creds");
const mockDecrypt = vi.fn().mockReturnValue(JSON.stringify({ token: "mcp-token-123" }));
vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
}));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
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
  // Mirrors the real implementation's name-based mapping so route tests can
  // assert the wire `code` without importing the server-only SDK module.
  mcpErrorCodeFromError: (err: unknown) => {
    const name = err instanceof Error ? err.name : "";
    if (name === "McpAuthError") return "unauthorized";
    if (name === "McpServerError") return "server_error";
    if (name === "McpSchemaError") return "schema";
    return "network";
  },
}));

const mockRegenerateOpenClawConfig = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: (...args: unknown[]) => mockRegenerateOpenClawConfig(...args),
}));

const { mockInsertValues, mockSelectFrom } = vi.hoisted(() => ({
  mockInsertValues: vi.fn(),
  mockSelectFrom: vi.fn(),
}));

const mockMcpConnection = {
  id: "conn-mcp-1",
  type: "mcp",
  name: "My GitHub MCP",
  description: "GitHub MCP server",
  credentials: "encrypted-creds",
  data: {
    type: "mcp",
    preset: "github",
    transport: "http",
    url: "https://mcp.example.com/github",
    tools: [{ name: "list_repos", description: "List repos", inputSchema: { type: "object" } }],
    lastSyncAt: new Date().toISOString(),
  },
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: mockInsertValues.mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockMcpConnection]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: mockSelectFrom.mockImplementation(() => {
        const result = Promise.resolve([]) as Promise<unknown[]> & {
          where: ReturnType<typeof vi.fn>;
        };
        result.where = vi.fn().mockResolvedValue([]);
        return result;
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id", type: "type" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(path: string, options?: RequestInit) {
  return new NextRequest(`http://localhost:7777${path}`, options);
}

const adminSession = { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };
const memberSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

const validMcpBody = {
  type: "mcp",
  name: "My GitHub MCP",
  description: "GitHub MCP server",
  preset: "github",
  transport: "http",
  url: "https://mcp.example.com/github",
  token: "mcp-token-123",
};

const mockTools = [
  { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
  { name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/integrations (type=mcp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockGetSession.mockResolvedValue(adminSession);
    mockListMcpTools.mockResolvedValue(mockTools);
    mockInsertValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([mockMcpConnection]),
    });
    mockSelectFrom.mockImplementation(() => {
      const result = Promise.resolve([]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([]);
      return result;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("happy path: creates MCP connection with discovered tools and returns 201", async () => {
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(201);

    // Discovery was called with correct args
    expect(mockListMcpTools).toHaveBeenCalledWith({
      url: validMcpBody.url,
      transport: validMcpBody.transport,
      token: validMcpBody.token,
    });

    // Credentials are encrypted before storage
    expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify({ token: validMcpBody.token }));

    // DB insert includes tools and lastSyncAt in data column
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mcp",
        name: validMcpBody.name,
        credentials: "encrypted-creds",
        data: expect.objectContaining({
          type: "mcp",
          preset: validMcpBody.preset,
          transport: validMcpBody.transport,
          url: validMcpBody.url,
          tools: mockTools,
          lastSyncAt: expect.any(String),
        }),
      })
    );

    // Audit log deferred with success outcome and mcp detail
    expect(mockDeferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.changed",
        resource: expect.stringContaining("integration:"),
        detail: expect.objectContaining({
          action: "integration_created",
          type: "mcp",
          name: validMcpBody.name,
          mcp: expect.objectContaining({
            preset: validMcpBody.preset,
            transport: validMcpBody.transport,
            url: validMcpBody.url,
            toolCount: mockTools.length,
          }),
        }),
        outcome: "success",
      })
    );

    // OpenClaw config regenerated
    expect(mockRegenerateOpenClawConfig).toHaveBeenCalled();

    // Response body is the created connection
    expect(body).toHaveProperty("id");
  });

  it("rejects unknown preset with 400", async () => {
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({
        ...validMcpBody,
        preset: "salesforce", // not in the allowed enum
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("returns 502 and does NOT save when discovery returns 401, audits outcome=failure", async () => {
    const { McpAuthError } = await import("@/lib/integrations/mcp-client");
    mockListMcpTools.mockRejectedValueOnce(new McpAuthError());

    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("MCP discovery failed");
    expect(body.detail).toBeDefined();
    // The dialog maps this stable code onto a human-friendly message
    // (mcp-error-messages.ts) instead of showing the raw protocol error.
    expect(body.code).toBe("unauthorized");

    // Must NOT write to DB
    expect(mockInsertValues).not.toHaveBeenCalled();

    // Audit with outcome: "failure"
    expect(mockDeferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.changed",
        detail: expect.objectContaining({
          action: "integration_created",
          error: expect.any(String),
        }),
        outcome: "failure",
      })
    );
  });

  it("returns 403 for non-admin users and never calls listMcpTools", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);

    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

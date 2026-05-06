import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockGetSession,
  mockAppendAuditLog,
  mockDbDelete,
  mockDbDeleteWhere,
  mockDbSelect,
  mockDbSelectFrom,
  mockDbSelectWhere,
} = vi.hoisted(() => {
  const mockDbDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDbDelete = vi.fn().mockReturnValue({ where: mockDbDeleteWhere });

  const mockDbSelectWhere = vi.fn();
  const mockDbSelectFrom = vi.fn().mockReturnValue({ where: mockDbSelectWhere });
  const mockDbSelect = vi.fn().mockReturnValue({ from: mockDbSelectFrom });

  return {
    mockGetSession: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    mockDbDelete,
    mockDbDeleteWhere,
    mockDbSelect,
    mockDbSelectFrom,
    mockDbSelectWhere,
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

vi.mock("@/lib/encryption", () => ({
  encrypt: vi.fn().mockReturnValue("encrypted"),
  decrypt: vi.fn().mockReturnValue(JSON.stringify({ token: "tok" })),
}));

vi.mock("@/lib/integrations/oauth-settings", () => ({
  deleteOAuthSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("@/lib/integrations/mask-credentials", () => ({
  maskConnectionCredentials: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/api-validation", () => ({
  parseRequestBody: vi.fn(),
  formatValidationError: vi.fn(),
}));

vi.mock("@/lib/integrations/odoo-schema", () => ({
  odooCredentialsSchema: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id", type: "type", name: "name", data: "data" },
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    delete: (...args: unknown[]) => mockDbDelete(...args),
  },
}));

// ── Test data ─────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };

const mockMcpConnection = {
  id: "conn-mcp-del-1",
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
    lastSyncAt: "2026-01-01T00:00:00.000Z",
  },
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function makeDeleteRequest(connectionId: string) {
  return new NextRequest(`http://localhost:7777/api/integrations/${connectionId}`, {
    method: "DELETE",
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DELETE /api/integrations/[connectionId] (type=mcp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    // DB select returns the MCP connection
    mockDbSelectWhere.mockResolvedValue([mockMcpConnection]);
    mockDbDeleteWhere.mockResolvedValue(undefined);
  });

  it("returns 200 and writes audit detail with name, type=mcp, and mcp.{preset,transport,url}", async () => {
    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");

    const request = makeDeleteRequest(mockMcpConnection.id);
    const ctx = { params: Promise.resolve({ connectionId: mockMcpConnection.id }) };

    const response = await DELETE(request, ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });

    // DB delete was called
    expect(mockDbDelete).toHaveBeenCalled();
    expect(mockDbDeleteWhere).toHaveBeenCalled();

    // Audit log contains MCP-specific fields
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.changed",
        outcome: "success",
        detail: expect.objectContaining({
          action: "integration_deleted",
          name: "My GitHub MCP",
          type: "mcp",
          mcp: expect.objectContaining({
            preset: "github",
            transport: "http",
            url: "https://mcp.example.com/github",
          }),
        }),
      })
    );
  });

  it("returns 404 when connection is not found", async () => {
    mockDbSelectWhere.mockResolvedValue([]);

    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");

    const request = makeDeleteRequest("nonexistent");
    const ctx = { params: Promise.resolve({ connectionId: "nonexistent" }) };

    const response = await DELETE(request, ctx);

    expect(response.status).toBe(404);
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin users and does not delete", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-2", email: "member@test.com", role: "member" },
    });

    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");

    const request = makeDeleteRequest(mockMcpConnection.id);
    const ctx = { params: Promise.resolve({ connectionId: mockMcpConnection.id }) };

    const response = await DELETE(request, ctx);

    expect(response.status).toBe(403);
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });
});

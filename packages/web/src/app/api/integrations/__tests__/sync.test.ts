import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockGetSession,
  mockDecrypt,
  mockDeferAuditLog,
  mockListMcpTools,
  mockRegenerateOpenClawConfig,
  mockUpdateSet,
  mockUpdateWhere,
  mockDelete,
  mockSelectWhere,
} = vi.hoisted(() => {
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });

  return {
    mockGetSession: vi.fn(),
    mockDecrypt: vi.fn().mockReturnValue(JSON.stringify({ token: "mcp-token-123" })),
    mockDeferAuditLog: vi.fn(),
    mockListMcpTools: vi.fn(),
    mockRegenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
    mockUpdateSet,
    mockUpdateWhere,
    mockDelete: vi.fn(),
    mockSelectWhere: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  encrypt: vi.fn().mockReturnValue("encrypted"),
}));

vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

vi.mock("@/lib/integrations/mcp-client", () => ({
  listMcpTools: (...args: unknown[]) => mockListMcpTools(...args),
}));

vi.mock("@/lib/integrations/mcp-tool-diff", () => ({
  diffMcpTools: (before: { name: string }[], after: { name: string }[]) => {
    const beforeNames = new Set(before.map((t) => t.name));
    const afterNames = new Set(after.map((t) => t.name));
    return {
      added: after.filter((t) => !beforeNames.has(t.name)),
      removed: before.filter((t) => !afterNames.has(t.name)),
      unchanged: after.filter((t) => beforeNames.has(t.name)),
    };
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: (...args: unknown[]) => mockRegenerateOpenClawConfig(...args),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockSelectWhere }),
    }),
    update: vi.fn().mockReturnValue({ set: mockUpdateSet }),
    delete: mockDelete,
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id", type: "type", data: "data" },
  agentMcpToolPermissions: { connectionId: "connectionId", toolName: "toolName" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ _type: "and", args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ _type: "inArray", col, vals })),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };
const memberSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

const toolA = { name: "list_repos", description: "List repos", inputSchema: { type: "object" } };
const toolB = {
  name: "create_issue",
  description: "Create issue",
  inputSchema: { type: "object" },
};
const toolC = { name: "delete_repo", description: "Delete repo", inputSchema: { type: "object" } };

const baseMcpConnection = {
  id: "conn-mcp-1",
  type: "mcp",
  name: "My GitHub MCP",
  description: "GitHub MCP server",
  credentials: "encrypted-creds",
  data: {
    type: "mcp",
    preset: "github",
    transport: "http" as const,
    url: "https://mcp.example.com/github",
    tools: [toolA, toolB],
    lastSyncAt: "2026-01-01T00:00:00.000Z",
  },
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const nonMcpConnection = {
  ...baseMcpConnection,
  id: "conn-other-1",
  type: "web-search",
  data: { type: "web-search" },
};

function makeRequest(connectionId: string) {
  return new NextRequest(`http://localhost:7777/api/integrations/${connectionId}/sync`, {
    method: "POST",
  });
}

function makeParams(connectionId: string) {
  return { params: Promise.resolve({ connectionId }) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/integrations/[connectionId]/sync (MCP)", () => {
  // Use dynamic import so module mocks are applied in this isolated context.
  // Dynamic import inside beforeEach is loaded once and cached by the module system.
  let POST: Awaited<
    ReturnType<typeof import("@/app/api/integrations/[connectionId]/sync/route")>
  >["POST"];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockGetSession.mockResolvedValue(adminSession);
    mockListMcpTools.mockResolvedValue([toolA, toolB]);
    mockSelectWhere.mockResolvedValue([baseMcpConnection]);
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });

    const mod = await import("@/app/api/integrations/[connectionId]/sync/route");
    POST = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Test 1: no-change path ─────────────────────────────────────────────

  it("no-change: updates lastSyncAt, audits with empty diff, calls regenerateOpenClawConfig", async () => {
    // Discovery returns the exact same tools as stored
    mockListMcpTools.mockResolvedValue([toolA, toolB]);

    const res = await POST(makeRequest("conn-mcp-1"), makeParams("conn-mcp-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true });
    expect(body.diff).toEqual({ added: [], removed: [], total: 2 });

    // Audit with empty diff — note: post-rebase the route now uses
    // `eventType: "integration.synced"` (main introduced this for Odoo,
    // shared with MCP) instead of an `action: "integration_mcp_synced"`
    // discriminator inside detail.
    expect(mockDeferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.synced",
        detail: expect.objectContaining({
          id: "conn-mcp-1",
          name: "My GitHub MCP",
          tools: {
            added: [],
            removed: [],
            total: 2,
          },
        }),
        outcome: "success",
      })
    );

    // Config regenerated
    expect(mockRegenerateOpenClawConfig).toHaveBeenCalled();

    // Connection row updated with new lastSyncAt
    expect(mockUpdateSet).toHaveBeenCalled();
  });

  // ── Test 2: added tools path ───────────────────────────────────────────

  it("added: includes new tools in diff, audits added list", async () => {
    // Discovery returns one new tool (toolC) in addition to existing two
    mockListMcpTools.mockResolvedValue([toolA, toolB, toolC]);

    const res = await POST(makeRequest("conn-mcp-1"), makeParams("conn-mcp-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.diff).toEqual({
      added: [{ name: "delete_repo" }],
      removed: [],
      total: 3,
    });

    expect(mockDeferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.synced",
        detail: expect.objectContaining({
          tools: {
            added: [{ name: "delete_repo" }],
            removed: [],
            total: 3,
          },
        }),
        outcome: "success",
      })
    );
  });

  // ── Test 3: removed tools — drift detected at GET time, not eager delete ─

  it("removed: does NOT cascade-delete agentMcpToolPermissions; drift surfaces at GET time", async () => {
    // Discovery returns only toolA (toolB was removed)
    mockListMcpTools.mockResolvedValue([toolA]);

    const res = await POST(makeRequest("conn-mcp-1"), makeParams("conn-mcp-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.diff).toEqual({
      added: [],
      removed: [{ name: "create_issue" }],
      total: 1,
    });

    // No cascade delete — sync only updates the connection row.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalled();

    // Audit diff reflects the removal
    expect(mockDeferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.synced",
        detail: expect.objectContaining({
          tools: expect.objectContaining({
            removed: [{ name: "create_issue" }],
          }),
        }),
        outcome: "success",
      })
    );

    // Config regenerated
    expect(mockRegenerateOpenClawConfig).toHaveBeenCalled();
  });

  // ── Test 3b: discovery failure returns success:false with no DB write ──
  // Post-rebase, the route matches main's Odoo behaviour: generic discovery
  // failures return 200 with `success: false, error`, no audit row, no
  // DB mutation. Auth failures (401/403) take a separate branch that flips
  // the connection into `auth_failed` — covered by the integration suite.

  it("returns success:false without DB write when MCP discovery throws", async () => {
    mockListMcpTools.mockRejectedValue(new Error("connection refused"));

    const res = await POST(makeRequest("conn-mcp-1"), makeParams("conn-mcp-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/connection refused/);

    // No DB write on failure
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  // ── Test 4: non-admin 403 ──────────────────────────────────────────────

  it("returns 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValue(memberSession);

    const res = await POST(makeRequest("conn-mcp-1"), makeParams("conn-mcp-1"));

    expect(res.status).toBe(403);
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  // ── Test 5: non-mcp and non-odoo connection returns 400 ──────────────

  it("returns 400 for connection type that is neither mcp nor odoo", async () => {
    mockSelectWhere.mockResolvedValue([nonMcpConnection]);

    const res = await POST(makeRequest("conn-other-1"), makeParams("conn-other-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBeDefined();
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});

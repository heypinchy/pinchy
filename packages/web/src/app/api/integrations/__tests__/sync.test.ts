import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockGetSession,
  mockDecrypt,
  mockDeferAuditLog,
  mockListMcpTools,
  mockRegenerateOpenClawConfig,
  mockTransaction,
  mockTxUpdateSet,
  mockTxDeleteWhere,
  mockSelectWhere,
} = vi.hoisted(() => {
  const mockTxUpdateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const mockTxDeleteWhere = vi.fn().mockResolvedValue(undefined);

  const mockTransaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = {
      update: vi.fn().mockReturnValue({ set: mockTxUpdateSet }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ where: mockTxDeleteWhere }),
      }),
    };
    return cb(tx);
  });

  return {
    mockGetSession: vi.fn(),
    mockDecrypt: vi.fn().mockReturnValue(JSON.stringify({ token: "mcp-token-123" })),
    mockDeferAuditLog: vi.fn(),
    mockListMcpTools: vi.fn(),
    mockRegenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
    mockTransaction,
    mockTxUpdateSet,
    mockTxDeleteWhere,
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
    transaction: mockTransaction,
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

    // Reset transaction mock to use fresh inner mocks
    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    mockTxUpdateSet.mockReturnValue({ where: updateWhereMock });
    mockTxDeleteWhere.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        update: vi.fn().mockReturnValue({ set: mockTxUpdateSet }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ where: mockTxDeleteWhere }),
        }),
      };
      return cb(tx);
    });

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

    // Audit with empty diff
    expect(mockDeferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          action: "integration_mcp_synced",
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

    // Transaction executed (to update lastSyncAt)
    expect(mockTransaction).toHaveBeenCalled();
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
        detail: expect.objectContaining({
          action: "integration_mcp_synced",
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

  // ── Test 3: removed tools with cascade delete ──────────────────────────

  it("removed: deletes matching agentMcpToolPermissions rows in same transaction", async () => {
    // Discovery returns only toolA (toolB was removed)
    mockListMcpTools.mockResolvedValue([toolA]);

    let capturedTx: {
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    } | null = null;

    const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    const txDeleteInner = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const txDeleteOuter = vi.fn().mockReturnValue({ where: txDeleteInner });

    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      capturedTx = {
        update: vi.fn().mockReturnValue({ set: txUpdateSet }),
        delete: vi.fn().mockReturnValue({ where: txDeleteOuter }),
      };
      return cb(capturedTx);
    });

    const res = await POST(makeRequest("conn-mcp-1"), makeParams("conn-mcp-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.diff).toEqual({
      added: [],
      removed: [{ name: "create_issue" }],
      total: 1,
    });

    // Transaction was used
    expect(mockTransaction).toHaveBeenCalled();

    // delete was called on the tx (cascade removal of tool permissions)
    expect(capturedTx!.delete).toHaveBeenCalled();

    // Audit diff reflects the removal
    expect(mockDeferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          action: "integration_mcp_synced",
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

  // ── Test 4: non-admin 403 ──────────────────────────────────────────────

  it("returns 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValue(memberSession);

    const res = await POST(makeRequest("conn-mcp-1"), makeParams("conn-mcp-1"));

    expect(res.status).toBe(403);
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ── Test 5: non-mcp and non-odoo connection returns 400 ──────────────

  it("returns 400 for connection type that is neither mcp nor odoo", async () => {
    mockSelectWhere.mockResolvedValue([nonMcpConnection]);

    const res = await POST(makeRequest("conn-other-1"), makeParams("conn-other-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBeDefined();
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks (accessible inside vi.mock factories) ───────────────────
const {
  mockGetSession,
  mockSelectFrom,
  mockSelectWhere,
  mockInsertValues,
  mockDeleteWhere,
  mockAppendAuditLog,
  mockTransaction,
  mockTxDeleteWhere,
  mockTxInsertValues,
  mockTxSelectWhere,
} = vi.hoisted(() => {
  const mockTxDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockTxInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockTxSelectWhere = vi.fn().mockResolvedValue([]);
  const mockTransaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: mockTxSelectWhere,
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: mockTxDeleteWhere }),
      insert: vi.fn().mockReturnValue({ values: mockTxInsertValues }),
    };
    return cb(tx);
  });

  return {
    mockGetSession: vi.fn().mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", role: "admin" },
    }),
    mockSelectFrom: vi.fn(),
    mockSelectWhere: vi.fn(),
    mockInsertValues: vi.fn(),
    mockDeleteWhere: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    mockTransaction,
    mockTxDeleteWhere,
    mockTxInsertValues,
    mockTxSelectWhere,
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: mockSelectFrom }),
    insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
    delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
    transaction: mockTransaction,
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

import { GET, PUT, DELETE } from "@/app/api/agents/[agentId]/integrations/route";
import { NextRequest } from "next/server";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

const AGENT_ID = "agent-1";
const CONNECTION_ID = "conn-1";

function makeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

describe("GET /api/agents/[agentId]/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFrom.mockImplementation(() => ({
      where: mockSelectWhere.mockResolvedValue([]),
    }));
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`);
    const res = await GET(req, makeParams(AGENT_ID));

    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    });

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`);
    const res = await GET(req, makeParams(AGENT_ID));

    expect(res.status).toBe(403);
  });

  it("returns empty array when no permissions exist", async () => {
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`);
    const res = await GET(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns permissions grouped by connection", async () => {
    mockSelectFrom.mockReturnValueOnce({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            integration_connections: {
              id: CONNECTION_ID,
              name: "My Odoo",
              type: "odoo",
              data: { models: [{ model: "res.partner", name: "Contact" }] },
            },
            agent_connection_permissions: { model: "res.partner", operation: "read" },
          },
          {
            integration_connections: {
              id: CONNECTION_ID,
              name: "My Odoo",
              type: "odoo",
              data: { models: [{ model: "res.partner", name: "Contact" }] },
            },
            agent_connection_permissions: { model: "res.partner", operation: "create" },
          },
        ]),
      }),
    });

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`);
    const res = await GET(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].connectionId).toBe(CONNECTION_ID);
    expect(body[0].connectionName).toBe("My Odoo");
    expect(body[0].connectionType).toBe("odoo");
    expect(body[0].permissions).toEqual([
      { model: "res.partner", modelName: "Contact", operation: "read" },
      { model: "res.partner", modelName: "Contact", operation: "create" },
    ]);
  });
});

describe("PUT /api/agents/[agentId]/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFrom.mockImplementation(() => ({
      where: mockSelectWhere,
    }));
    mockDeleteWhere.mockResolvedValue(undefined);
    mockInsertValues.mockResolvedValue(undefined);
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({ connectionId: CONNECTION_ID, permissions: [] }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    });

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({ connectionId: CONNECTION_ID, permissions: [] }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(403);
  });

  it("returns 400 when connectionId is missing", async () => {
    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({ permissions: [] }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(400);
  });

  it("returns 404 when connection does not exist", async () => {
    mockSelectWhere.mockResolvedValueOnce([]); // connection not found

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({ connectionId: CONNECTION_ID, permissions: [] }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(404);
  });

  it("deletes existing permissions and inserts new ones", async () => {
    // Connection exists (validation query runs outside transaction)
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]);
    // Existing permissions for diff (inside transaction)
    mockTxSelectWhere.mockResolvedValueOnce([{ model: "res.partner", operation: "read" }]);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [
          { model: "res.partner", operation: "read" },
          { model: "sale.order", operation: "read" },
        ],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    expect(mockTxDeleteWhere).toHaveBeenCalled();
    expect(mockTxInsertValues).toHaveBeenCalled();
  });

  it("does not call regenerateOpenClawConfig (delegated to agent PATCH)", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]);
    mockTxSelectWhere.mockResolvedValueOnce([]);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [{ model: "res.partner", operation: "read" }],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("writes audit log with added/removed diff", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]);
    // Existing permissions (inside transaction)
    mockTxSelectWhere.mockResolvedValueOnce([
      { model: "res.partner", operation: "read" },
      { model: "res.partner", operation: "create" },
    ]);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [
          { model: "res.partner", operation: "read" },
          { model: "sale.order", operation: "read" },
        ],
      }),
    });
    await PUT(req, makeParams(AGENT_ID));

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.changed",
        resource: `agent:${AGENT_ID}`,
        detail: expect.objectContaining({
          action: "agent_integration_permissions_updated",
          agentId: AGENT_ID,
          connectionId: CONNECTION_ID,
        }),
      })
    );
  });

  it("wraps DELETE+INSERT in a database transaction", async () => {
    // Connection exists (validation query runs outside transaction)
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]);
    mockTxSelectWhere.mockResolvedValueOnce([]);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [{ model: "email", operation: "read" }],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxDeleteWhere).toHaveBeenCalled();
    expect(mockTxInsertValues).toHaveBeenCalled();
    // Must NOT use db.delete/insert directly (outside transaction)
    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("handles empty permissions (clear all)", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]);
    mockTxSelectWhere.mockResolvedValueOnce([{ model: "res.partner", operation: "read" }]);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    expect(mockTxDeleteWhere).toHaveBeenCalled();
    // Should not insert when permissions are empty
    expect(mockTxInsertValues).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/agents/[agentId]/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteWhere.mockResolvedValue(undefined);
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "DELETE",
    });
    const res = await DELETE(req, makeParams(AGENT_ID));

    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    });

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "DELETE",
    });
    const res = await DELETE(req, makeParams(AGENT_ID));

    expect(res.status).toBe(403);
  });

  it("deletes all integration permissions for the agent", async () => {
    // Existing permissions for audit log
    mockSelectFrom.mockImplementationOnce(() => ({
      where: vi.fn().mockResolvedValue([
        { model: "res.partner", operation: "read", connectionId: CONNECTION_ID },
        { model: "sale.order", operation: "read", connectionId: CONNECTION_ID },
      ]),
    }));

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "DELETE",
    });
    const res = await DELETE(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it("does not call regenerateOpenClawConfig (delegated to agent PATCH)", async () => {
    mockSelectFrom.mockImplementationOnce(() => ({
      where: vi.fn().mockResolvedValue([]),
    }));

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "DELETE",
    });
    await DELETE(req, makeParams(AGENT_ID));

    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("writes audit log with removed permissions", async () => {
    mockSelectFrom.mockImplementationOnce(() => ({
      where: vi
        .fn()
        .mockResolvedValue([
          { model: "res.partner", operation: "read", connectionId: CONNECTION_ID },
        ]),
    }));

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "DELETE",
    });
    await DELETE(req, makeParams(AGENT_ID));

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.changed",
        resource: `agent:${AGENT_ID}`,
        detail: expect.objectContaining({
          action: "agent_integration_permissions_cleared",
          agentId: AGENT_ID,
          removed: [{ model: "res.partner", operation: "read" }],
        }),
      })
    );
  });
});

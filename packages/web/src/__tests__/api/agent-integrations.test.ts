import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks (accessible inside vi.mock factories) ───────────────────
const {
  mockGetSession,
  mockSelectFrom,
  mockSelectWhere,
  mockInsertValues,
  mockDeleteWhere,
  mockAppendAuditLog,
  mockRecordAuditFailure,
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
    mockRecordAuditFailure: vi.fn(),
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

vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: (...args: unknown[]) => mockRecordAuditFailure(...args),
}));

import { GET, PUT, DELETE } from "@/app/api/agents/[agentId]/integrations/route";
import { NextRequest } from "next/server";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { agentConnectionPermissions, integrationConnections } from "@/db/schema";

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
    // Two-query shape: permissions come back empty, so the connections query
    // is skipped entirely and grouping yields [].
    mockSelectFrom.mockImplementation((table: unknown) => {
      if (table === agentConnectionPermissions) {
        return { where: vi.fn().mockResolvedValue([]) };
      }
      throw new Error(`unexpected table passed to .from(): ${String(table)}`);
    });

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`);
    const res = await GET(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns permissions grouped by connection", async () => {
    mockSelectFrom.mockImplementation((table: unknown) => {
      if (table === agentConnectionPermissions) {
        return {
          where: vi.fn().mockResolvedValue([
            { connectionId: CONNECTION_ID, model: "res.partner", operation: "read" },
            { connectionId: CONNECTION_ID, model: "res.partner", operation: "create" },
          ]),
        };
      }
      if (table === integrationConnections) {
        return {
          where: vi.fn().mockResolvedValue([
            {
              id: CONNECTION_ID,
              name: "My Odoo",
              type: "odoo",
              data: { models: [{ model: "res.partner", name: "Contact" }] },
            },
          ]),
        };
      }
      throw new Error(`unexpected table passed to .from(): ${String(table)}`);
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

  // Regression guard for the same boot-OOM fan-out class fixed in build.ts
  // (loadAgentConnectionPermissions). The old handler used a projection-less
  // `.innerJoin(integrationConnections, …)`, which materializes the full
  // `integrationConnections.data` blob ONCE PER PERMISSION ROW. An agent with
  // many model permissions on a big-blob Odoo connection would fan a multi-
  // hundred-kB catalog out across every row in a single admin request. The
  // fix loads permissions and the referenced connections as two separate
  // queries and stitches them in memory, so each connection blob is fetched
  // exactly once. This mock provides NO `.innerJoin` on the permissions query
  // — a revert to the fan-out join throws here instead of silently passing.
  it("fetches each connection blob once (no per-permission-row fan-out) and still groups correctly", async () => {
    const bigBlob = {
      models: Array.from({ length: 300 }, (_, i) => ({ model: `model.${i}`, name: `Model ${i}` })),
    };
    const connection = {
      id: CONNECTION_ID,
      name: "Big Odoo",
      type: "odoo",
      data: bigBlob,
    };
    const permissionRows = Array.from({ length: 40 }, (_, i) => ({
      agentId: AGENT_ID,
      connectionId: CONNECTION_ID,
      model: `model.${i}`,
      operation: "read",
    }));

    let integrationConnectionsFromCalls = 0;
    mockSelectFrom.mockImplementation((table: unknown) => {
      if (table === agentConnectionPermissions) {
        return { where: vi.fn().mockResolvedValue(permissionRows) };
      }
      if (table === integrationConnections) {
        integrationConnectionsFromCalls++;
        return { where: vi.fn().mockResolvedValue([connection]) };
      }
      throw new Error(`unexpected table passed to .from(): ${String(table)}`);
    });

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`);
    const res = await GET(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    // All 40 permissions grouped under the single connection…
    expect(body).toHaveLength(1);
    expect(body[0].connectionId).toBe(CONNECTION_ID);
    expect(body[0].permissions).toHaveLength(40);
    expect(body[0].permissions[0]).toEqual({
      model: "model.0",
      modelName: "Model 0",
      operation: "read",
    });
    // …while the connection (and its blob) is queried exactly once, not once
    // per permission row.
    expect(integrationConnectionsFromCalls).toBe(1);
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

  // C8: pre-#328 template creation could persist raw per-tool operations
  // ("search", "list") as agent_connection_permissions rows — before this
  // fix the PUT schema validated `operation` as a bare non-empty string, so
  // NEW (model:"email", operation:"search") rows could still be minted via
  // the API today, creating an invisible standing "read" grant (the UI
  // filtered these rows out of the checkbox matrix pre-C2) while the audit
  // row logged the raw string "search". Restrict the email vocabulary to
  // EMAIL_OPERATIONS (read/draft/send) at the schema layer; non-email models
  // (e.g. Odoo's res.partner) are unaffected — this route is generic.
  it("returns 400 for a legacy 'search' operation on model 'email', naming the allowed values", async () => {
    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [{ model: "email", operation: "search" }],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("read");
    expect(JSON.stringify(body)).toContain("draft");
    expect(JSON.stringify(body)).toContain("send");
  });

  it("returns 400 for a legacy 'list' operation on model 'email'", async () => {
    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [{ model: "email", operation: "list" }],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(400);
  });

  it("returns 200 for a valid 'read' operation on model 'email'", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
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
  });

  it("does not restrict operation vocabulary for non-email models (e.g. Odoo)", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
    mockTxSelectWhere.mockResolvedValueOnce([]);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [{ model: "res.partner", operation: "search" }],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
  });

  it("returns 404 when agent does not exist", async () => {
    mockSelectWhere.mockResolvedValueOnce([]); // agent not found

    const req = new NextRequest(`http://localhost:7777/api/agents/ghost-agent/integrations`, {
      method: "PUT",
      body: JSON.stringify({ connectionId: CONNECTION_ID, permissions: [] }),
    });
    const res = await PUT(req, makeParams("ghost-agent"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Agent not found");
  });

  it("returns 404 when connection does not exist", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
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
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
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
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
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
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
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
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
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
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
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

  it("does not turn a committed change into a 500 when the audit write fails", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
    mockTxSelectWhere.mockResolvedValueOnce([]);
    mockAppendAuditLog.mockRejectedValueOnce(new Error("audit db unavailable"));

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [{ model: "res.partner", operation: "read" }],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    // The permission change already committed; the audit failure must be
    // recorded for reconciliation, not surfaced as a 500.
    expect(res.status).toBe(200);
    expect(mockRecordAuditFailure).toHaveBeenCalled();
  });

  it("does not leak the raw DB error text when the permission write fails", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent exists
    mockSelectWhere.mockResolvedValueOnce([{ id: CONNECTION_ID }]); // connection exists
    mockTransaction.mockRejectedValueOnce(
      new Error(
        'insert or update on table "agent_connection_permissions" violates foreign key constraint "agent_connection_permissions_agent_id_agents_id_fk"'
      )
    );

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        permissions: [{ model: "res.partner", operation: "read" }],
      }),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update integration permissions");
    expect(JSON.stringify(body)).not.toContain("foreign key constraint");
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

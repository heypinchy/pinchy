import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetSession, mockFinalize, mockDb } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockFinalize: vi.fn().mockResolvedValue(undefined),
  mockDb: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("@/lib/auth", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));
vi.mock("@/lib/integrations/finalize-deletion", () => ({
  finalizeIntegrationDeletion: (...a: unknown[]) => mockFinalize(...a),
}));
vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
  agentConnectionPermissions: { connectionId: "connectionId", agentId: "agentId" },
  agents: { id: "id", name: "name" },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn((a, b) => ({ field: a, val: b })) }));

const baseConn = {
  id: "conn-1",
  type: "odoo",
  name: "My Odoo",
  credentials: "x",
  description: "",
  data: null,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Configurable tx mock
let txSnapshot: { id: string; name: string }[] = [];
const txMock = {
  selectDistinct: vi.fn(() => ({
    from: () => ({ innerJoin: () => ({ where: () => Promise.resolve(txSnapshot) }) }),
  })),
  delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
};
vi.mock("@/db", () => ({ db: mockDb }));

import { DELETE } from "@/app/api/integrations/[connectionId]/with-permissions/route";

const makeReq = () =>
  new Request("http://x/api/integrations/conn-1/with-permissions", { method: "DELETE" });
const makeCtx = () => ({ params: Promise.resolve({ connectionId: "conn-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  txSnapshot = [];
  mockDb.transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) => cb(txMock));
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => Promise.resolve([baseConn]) }),
  });
});

describe("DELETE /api/integrations/:id/with-permissions", () => {
  it("returns 401 for unauthenticated requests", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await DELETE(makeReq() as any, makeCtx());
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u", role: "member" } });
    const res = await DELETE(makeReq() as any, makeCtx());
    expect(res.status).toBe(403);
  });

  it("returns 404 if connection doesn't exist", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u", role: "admin" } });
    mockDb.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) });
    const res = await DELETE(makeReq() as any, makeCtx());
    expect(res.status).toBe(404);
  });

  it("deletes permissions + integration in a transaction and calls finalize with snapshot", async () => {
    txSnapshot = [{ id: "a1", name: "Bot" }];
    mockGetSession.mockResolvedValue({ user: { id: "u1", role: "admin" } });
    const res = await DELETE(makeReq() as any, makeCtx());
    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledOnce();
    expect(mockFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "u1",
        connection: expect.objectContaining({ id: "conn-1" }),
        detachedAgents: [{ id: "a1", name: "Bot" }],
      })
    );
  });

  it("handles empty snapshot (no permissions) — still succeeds", async () => {
    txSnapshot = [];
    mockGetSession.mockResolvedValue({ user: { id: "u1", role: "admin" } });
    const res = await DELETE(makeReq() as any, makeCtx());
    expect(res.status).toBe(200);
    expect(mockFinalize).toHaveBeenCalledWith(expect.objectContaining({ detachedAgents: [] }));
  });
});

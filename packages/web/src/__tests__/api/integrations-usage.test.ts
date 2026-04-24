import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetSession, mockDb } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockDb: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
  },
}));

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("@/lib/auth", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));
vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
  agentConnectionPermissions: { connectionId: "connectionId", agentId: "agentId" },
  agents: { id: "id", name: "name" },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn((a, b) => ({ field: a, val: b })) }));
vi.mock("@/db", () => ({ db: mockDb }));

import { GET } from "@/app/api/integrations/[connectionId]/usage/route";

const makeReq = () => new Request("http://x/api/integrations/conn-1/usage", { method: "GET" });
const makeCtx = () => ({ params: Promise.resolve({ connectionId: "conn-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => Promise.resolve([{ id: "conn-1" }]) }),
  });
  mockDb.selectDistinct.mockReturnValue({
    from: () => ({
      innerJoin: () => ({ where: () => Promise.resolve([]) }),
    }),
  });
});

describe("GET /api/integrations/:id/usage", () => {
  it("401 without session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(makeReq() as any, makeCtx());
    expect(res.status).toBe(401);
  });

  it("403 for non-admin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u", role: "member" } });
    const res = await GET(makeReq() as any, makeCtx());
    expect(res.status).toBe(403);
  });

  it("404 for unknown id", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u", role: "admin" } });
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([]) }),
    });
    const res = await GET(makeReq() as any, makeCtx());
    expect(res.status).toBe(404);
  });

  it("returns { agents: [] } for unused integration", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u", role: "admin" } });
    const res = await GET(makeReq() as any, makeCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [] });
  });

  it("returns deduplicated agent list", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u", role: "admin" } });
    mockDb.selectDistinct.mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: () =>
            Promise.resolve([
              { id: "a1", name: "Bot" },
              { id: "a2", name: "Smithers" },
            ]),
        }),
      }),
    });
    const res = await GET(makeReq() as any, makeCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agents: [
        { id: "a1", name: "Bot" },
        { id: "a2", name: "Smithers" },
      ],
    });
  });
});

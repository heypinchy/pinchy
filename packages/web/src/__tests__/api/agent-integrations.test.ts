/**
 * Auth-guard tests for /api/agents/[agentId]/integrations.
 * Behaviour tests are co-located with the route in
 * src/app/api/agents/[agentId]/integrations/__tests__/route.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks (accessible inside vi.mock factories) ───────────────────
const { mockGetSession } = vi.hoisted(() => {
  return {
    mockGetSession: vi.fn().mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", role: "admin" },
    }),
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: { api: { getSession: mockGetSession } },
}));

// Minimal DB mock — auth guard runs before any DB access
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    transaction: vi.fn().mockResolvedValue(undefined),
    query: {
      integrationConnections: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ _type: "and", args })),
}));

vi.mock("@/db/schema", () => ({
  agentConnectionPermissions: { agentId: "agentId", connectionId: "connectionId" },
  agentMcpToolPermissions: {
    agentId: "agentId",
    connectionId: "connectionId",
    toolName: "toolName",
  },
  integrationConnections: { id: "id", type: "type", name: "name", data: "data" },
}));

import { GET, PUT, DELETE } from "@/app/api/agents/[agentId]/integrations/route";
import { NextRequest } from "next/server";

const AGENT_ID = "agent-1";
const CONNECTION_ID = "conn-1";

function makeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

describe("GET /api/agents/[agentId]/integrations — auth guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

describe("PUT /api/agents/[agentId]/integrations — auth guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "PUT",
      body: JSON.stringify([]),
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
      body: JSON.stringify([{ kind: "odoo", connectionId: CONNECTION_ID, entries: [] }]),
    });
    const res = await PUT(req, makeParams(AGENT_ID));

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/agents/[agentId]/integrations — auth guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const req = new NextRequest(`http://localhost:7777/api/agents/${AGENT_ID}/integrations`, {
      method: "DELETE",
    });
    const res = await DELETE(req, makeParams(AGENT_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

// Mock db
const mockSelectWhere = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { status: "status" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  sql: vi.fn().mockReturnValue("count_sql"),
}));

import { NextRequest } from "next/server";

const adminSession = { user: { id: "u1", email: "admin@test.com", role: "admin" } };

function makeRequest() {
  return new NextRequest("http://localhost:7777/api/integrations/health");
}

describe("GET /api/integrations/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("returns { authFailedCount: N }", async () => {
    mockSelectWhere.mockResolvedValue([{ count: 2 }]);
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body).toEqual({ authFailedCount: 2 });
    expect(res.status).toBe(200);
  });

  it("returns { authFailedCount: 0 } when none failed", async () => {
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body).toEqual({ authFailedCount: 0 });
  });

  it("returns 403 for non-admin authenticated user", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u2", role: "user" } });
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });
});

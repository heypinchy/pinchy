import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
}));

// Build chainable mock: select().from().leftJoin().where().groupBy()
const mockGroupBy = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
const mockLeftJoin = vi.fn().mockReturnValue({ where: mockWhere });
const mockFrom = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock("@/db", () => ({
  db: { select: mockSelect },
}));

vi.mock("@/db/schema", () => ({
  usageRecords: {
    userId: "user_id",
    agentId: "agent_id",
    agentName: "agent_name",
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    estimatedCostUsd: "estimated_cost_usd",
    timestamp: "timestamp",
  },
  users: {
    id: "id",
    name: "name",
  },
}));

vi.mock("drizzle-orm", () => ({
  sum: vi.fn((col) => `sum(${col})`),
  gte: vi.fn((col, val) => ({ col, val, op: "gte" })),
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
}));

import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { eq, gte } from "drizzle-orm";

// ── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/usage/by-user", () => {
  let GET: typeof import("@/app/api/usage/by-user/route").GET;

  const sampleUsers = [
    {
      userId: "u1",
      userName: "Alice",
      totalInputTokens: "3000",
      totalOutputTokens: "1500",
      totalCost: "0.025000",
    },
    {
      userId: "u2",
      userName: "Bob",
      totalInputTokens: "5000",
      totalOutputTokens: "2000",
      totalCost: "0.045000",
    },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof requireAdmin> extends Promise<infer T> ? T : never);
    vi.mocked(isEnterprise).mockResolvedValue(true);

    // Reset chainable mock defaults
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ leftJoin: mockLeftJoin });
    mockLeftJoin.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ groupBy: mockGroupBy });

    const mod = await import("@/app/api/usage/by-user/route");
    GET = mod.GET;
  });

  it("returns 401 for unauthenticated users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const request = new NextRequest("http://localhost:7777/api/usage/by-user");
    const response = await GET(request);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const request = new NextRequest("http://localhost:7777/api/usage/by-user");
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 403 when not enterprise", async () => {
    vi.mocked(isEnterprise).mockResolvedValueOnce(false);

    const request = new NextRequest("http://localhost:7777/api/usage/by-user");
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Enterprise feature");
  });

  it("returns per-user aggregated data", async () => {
    mockGroupBy.mockResolvedValueOnce(sampleUsers);

    const request = new NextRequest("http://localhost:7777/api/usage/by-user");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.users).toHaveLength(2);
    expect(body.users[0]).toEqual(sampleUsers[0]);
    expect(body.users[1]).toEqual(sampleUsers[1]);

    // Verify default 30-day filter
    expect(gte).toHaveBeenCalledWith("timestamp", expect.any(Date));
  });

  it("joins with users table to include userName", async () => {
    mockGroupBy.mockResolvedValueOnce([sampleUsers[0]]);

    const request = new NextRequest("http://localhost:7777/api/usage/by-user");
    await GET(request);

    // Verify leftJoin was called with users table and eq on user ids
    expect(mockLeftJoin).toHaveBeenCalledWith({ id: "id", name: "name" }, expect.anything());
  });

  it("returns 400 for invalid days parameter", async () => {
    const request = new NextRequest("http://localhost:7777/api/usage/by-user?days=abc");
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "Invalid days parameter" });
  });

  it("supports agentId filter", async () => {
    mockGroupBy.mockResolvedValueOnce([sampleUsers[0]]);

    const request = new NextRequest("http://localhost:7777/api/usage/by-user?agentId=a1");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.users).toHaveLength(1);

    // Verify eq was called with agentId column and value
    expect(eq).toHaveBeenCalledWith("agent_id", "a1");
  });
});

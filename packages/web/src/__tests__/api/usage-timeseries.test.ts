import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

// Build chainable mock: select().from().where().groupBy().orderBy()
const mockOrderBy = vi.fn();
const mockGroupBy = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock("@/db", () => ({
  db: { select: mockSelect },
}));

vi.mock("@/db/schema", () => ({
  usageRecords: {
    agentId: "agent_id",
    agentName: "agent_name",
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    estimatedCostUsd: "estimated_cost_usd",
    timestamp: "timestamp",
  },
}));

vi.mock("drizzle-orm", () => ({
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    _tag: "sql",
    strings,
    values,
  })),
  sum: vi.fn((col) => `sum(${col})`),
  gte: vi.fn((col, val) => ({ col, val, op: "gte" })),
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
}));

import { requireAdmin } from "@/lib/api-auth";
import { eq, gte } from "drizzle-orm";

// ── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/usage/timeseries", () => {
  let GET: typeof import("@/app/api/usage/timeseries/route").GET;

  const sampleTimeseries = [
    {
      date: "2026-03-01",
      inputTokens: "5000",
      outputTokens: "2000",
      cost: "0.045000",
    },
    {
      date: "2026-03-02",
      inputTokens: "3000",
      outputTokens: "1000",
      cost: "0.025000",
    },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof requireAdmin> extends Promise<infer T> ? T : never);

    // Reset chainable mock defaults
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ groupBy: mockGroupBy });
    mockGroupBy.mockReturnValue({ orderBy: mockOrderBy });

    const mod = await import("@/app/api/usage/timeseries/route");
    GET = mod.GET;
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const request = new NextRequest("http://localhost:7777/api/usage/timeseries");
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns daily aggregated data", async () => {
    mockOrderBy.mockResolvedValueOnce(sampleTimeseries);

    const request = new NextRequest("http://localhost:7777/api/usage/timeseries");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual(sampleTimeseries[0]);
    expect(body.data[1]).toEqual(sampleTimeseries[1]);
  });

  it("filters by agentId", async () => {
    mockOrderBy.mockResolvedValueOnce([sampleTimeseries[0]]);

    const request = new NextRequest("http://localhost:7777/api/usage/timeseries?agentId=a1");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(1);

    // Verify eq was called with agentId column and value
    expect(eq).toHaveBeenCalledWith("agent_id", "a1");
  });

  it("defaults to 30 days", async () => {
    mockOrderBy.mockResolvedValueOnce(sampleTimeseries);

    const request = new NextRequest("http://localhost:7777/api/usage/timeseries");
    await GET(request);

    // Verify gte was called with timestamp column and a Date ~30 days ago
    expect(gte).toHaveBeenCalledWith("timestamp", expect.any(Date));
    const gteCall = vi.mocked(gte).mock.calls[0];
    const sinceDate = gteCall[1] as Date;
    const daysDiff = (Date.now() - sinceDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysDiff).toBeCloseTo(30, 0);
  });

  it("returns 400 for invalid days parameter", async () => {
    const request = new NextRequest("http://localhost:7777/api/usage/timeseries?days=abc");
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "Invalid days parameter" });
  });

  it("returns empty data when no records", async () => {
    mockOrderBy.mockResolvedValueOnce([]);

    const request = new NextRequest("http://localhost:7777/api/usage/timeseries");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
  });
});

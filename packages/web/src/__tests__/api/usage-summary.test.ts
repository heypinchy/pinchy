import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

// Build chainable mock: select().from().where().groupBy()
const mockGroupBy = vi.fn();
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
  sum: vi.fn((col) => `sum(${col})`),
  max: vi.fn((col) => `max(${col})`),
  gte: vi.fn((col, val) => ({ col, val, op: "gte" })),
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
}));

import { requireAdmin } from "@/lib/api-auth";
import { eq, gte } from "drizzle-orm";

// ── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/usage/summary", () => {
  let GET: typeof import("@/app/api/usage/summary/route").GET;

  const sampleAgents = [
    {
      agentId: "a1",
      agentName: "Smithers",
      totalInputTokens: "5000",
      totalOutputTokens: "2000",
      totalCost: "0.045000",
    },
    {
      agentId: "a2",
      agentName: "Helper",
      totalInputTokens: "3000",
      totalOutputTokens: "1000",
      totalCost: "0.025000",
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

    const mod = await import("@/app/api/usage/summary/route");
    GET = mod.GET;
  });

  it("returns 401 for unauthenticated users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const request = new NextRequest("http://localhost:7777/api/usage/summary");
    const response = await GET(request);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const request = new NextRequest("http://localhost:7777/api/usage/summary");
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns aggregated usage per agent with default 30-day filter", async () => {
    mockGroupBy.mockResolvedValueOnce(sampleAgents);

    const request = new NextRequest("http://localhost:7777/api/usage/summary");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agents).toHaveLength(2);
    expect(body.agents[0]).toEqual(sampleAgents[0]);
    expect(body.agents[1]).toEqual(sampleAgents[1]);

    // Verify gte was called with timestamp column and a Date ~30 days ago
    expect(gte).toHaveBeenCalledWith("timestamp", expect.any(Date));
  });

  it("supports ?days=7 parameter", async () => {
    mockGroupBy.mockResolvedValueOnce([sampleAgents[0]]);

    const request = new NextRequest("http://localhost:7777/api/usage/summary?days=7");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agents).toHaveLength(1);

    // Verify gte was called with a date approximately 7 days ago
    expect(gte).toHaveBeenCalledWith("timestamp", expect.any(Date));
    const gteCall = vi.mocked(gte).mock.calls[0];
    const sinceDate = gteCall[1] as Date;
    const daysDiff = (Date.now() - sinceDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysDiff).toBeCloseTo(7, 0);
  });

  it("supports ?days=0 for all-time data (no date filter)", async () => {
    mockGroupBy.mockResolvedValueOnce(sampleAgents);

    const request = new NextRequest("http://localhost:7777/api/usage/summary?days=0");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agents).toHaveLength(2);

    // gte should NOT have been called (no date filter)
    expect(gte).not.toHaveBeenCalled();
  });

  it("supports ?days=all for all-time data (no date filter)", async () => {
    mockGroupBy.mockResolvedValueOnce(sampleAgents);

    const request = new NextRequest("http://localhost:7777/api/usage/summary?days=all");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agents).toHaveLength(2);

    // gte should NOT have been called (no date filter)
    expect(gte).not.toHaveBeenCalled();
  });

  it("supports ?agentId=<id> filter", async () => {
    mockGroupBy.mockResolvedValueOnce([sampleAgents[0]]);

    const request = new NextRequest("http://localhost:7777/api/usage/summary?agentId=a1");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agents).toHaveLength(1);

    // Verify eq was called with agentId column and value
    expect(eq).toHaveBeenCalledWith("agent_id", "a1");
  });

  it("returns 400 for invalid days parameter", async () => {
    const request = new NextRequest("http://localhost:7777/api/usage/summary?days=abc");
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "Invalid days parameter" });
  });

  it("returns empty agents array when no data", async () => {
    mockGroupBy.mockResolvedValueOnce([]);

    const request = new NextRequest("http://localhost:7777/api/usage/summary");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agents).toEqual([]);
  });
});

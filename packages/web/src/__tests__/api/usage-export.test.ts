import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
}));

// Build chainable mock: select().from().where().orderBy().limit()
const mockLimit = vi.fn();
const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock("@/db", () => ({
  db: { select: mockSelect },
}));

vi.mock("@/db/schema", () => ({
  usageRecords: {
    timestamp: "timestamp",
    userId: "user_id",
    agentId: "agent_id",
    agentName: "agent_name",
    model: "model",
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cacheReadTokens: "cache_read_tokens",
    cacheWriteTokens: "cache_write_tokens",
    estimatedCostUsd: "estimated_cost_usd",
  },
}));

vi.mock("drizzle-orm", () => ({
  desc: vi.fn((col) => `desc(${col})`),
  gte: vi.fn((col, val) => ({ col, val, op: "gte" })),
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
}));

import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { eq, gte } from "drizzle-orm";

// ── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/usage/export", () => {
  let GET: typeof import("@/app/api/usage/export/route").GET;

  const sampleRecords = [
    {
      id: 1,
      timestamp: new Date("2026-03-20T10:00:00Z"),
      userId: "u1",
      agentId: "a1",
      agentName: "Smithers",
      sessionKey: "agent:a1:user-u1",
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      estimatedCostUsd: "0.012000",
    },
    {
      id: 2,
      timestamp: new Date("2026-03-21T14:00:00Z"),
      userId: "u2",
      agentId: "a2",
      agentName: "Helper",
      sessionKey: "agent:a2:user-u2",
      model: "gpt-4o",
      inputTokens: 2000,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: "0.025000",
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
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue(sampleRecords);

    const mod = await import("@/app/api/usage/export/route");
    GET = mod.GET;
  });

  it("returns 403 for non-enterprise", async () => {
    vi.mocked(isEnterprise).mockResolvedValueOnce(false);

    const request = new NextRequest("http://localhost:7777/api/usage/export");
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Enterprise feature");
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const request = new NextRequest("http://localhost:7777/api/usage/export");
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns JSON with correct content-type by default", async () => {
    const request = new NextRequest("http://localhost:7777/api/usage/export?format=json");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.records).toHaveLength(2);
    expect(body.records[0].agentName).toBe("Smithers");
  });

  it("returns CSV with correct headers and Content-Disposition", async () => {
    const request = new NextRequest("http://localhost:7777/api/usage/export?format=csv");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="usage-export.csv"'
    );
  });

  it("CSV has correct column headers", async () => {
    const request = new NextRequest("http://localhost:7777/api/usage/export?format=csv");
    const response = await GET(request);

    const csv = await response.text();
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "timestamp,userId,agentId,agentName,model,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,estimatedCostUsd"
    );
    // Verify data rows exist
    expect(lines).toHaveLength(3); // header + 2 records
    // Verify first data row contains expected values
    expect(lines[1]).toContain("u1");
    expect(lines[1]).toContain("Smithers");
    expect(lines[1]).toContain("1000");
  });

  it("returns 400 for invalid days parameter", async () => {
    const request = new NextRequest("http://localhost:7777/api/usage/export?days=abc");
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "Invalid days parameter" });
  });

  it("limits export to 100000 rows", async () => {
    mockLimit.mockResolvedValueOnce(sampleRecords);

    const request = new NextRequest("http://localhost:7777/api/usage/export");
    await GET(request);

    expect(mockLimit).toHaveBeenCalledWith(100000);
  });

  it("supports days filter", async () => {
    mockLimit.mockResolvedValueOnce(sampleRecords);

    const request = new NextRequest("http://localhost:7777/api/usage/export?days=7");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(gte).toHaveBeenCalledWith("timestamp", expect.any(Date));
  });

  it("supports agentId filter", async () => {
    mockLimit.mockResolvedValueOnce([sampleRecords[0]]);

    const request = new NextRequest("http://localhost:7777/api/usage/export?agentId=a1");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("agent_id", "a1");
  });
});

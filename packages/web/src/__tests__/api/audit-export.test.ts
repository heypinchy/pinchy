import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

const mockOrderBy = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock("@/db", () => ({
  db: { select: mockSelect },
}));

vi.mock("@/db/schema", () => ({
  auditLog: {
    id: "id",
    timestamp: "timestamp",
    actorType: "actor_type",
    actorId: "actor_id",
    eventType: "event_type",
    resource: "resource",
    detail: "detail",
    rowHmac: "row_hmac",
  },
}));

vi.mock("drizzle-orm", () => ({
  desc: vi.fn((col) => col),
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  gte: vi.fn((col, val) => ({ col, val })),
  lte: vi.fn((col, val) => ({ col, val })),
}));

import { requireAdmin } from "@/lib/api-auth";

describe("GET /api/audit/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
  });

  it("should return 403 for non-admin users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export");
    const response = await GET(request as any);
    expect(response.status).toBe(403);
  });

  it("should return CSV with correct headers", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-02-21T10:00:00Z"),
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        resource: null,
        detail: { email: "test@example.com" },
        rowHmac: "abc123",
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export");
    const response = await GET(request as any);

    expect(response.headers.get("Content-Type")).toBe("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain("audit-log-");

    const body = await response.text();
    expect(body).toContain("id,timestamp,actorType,actorId,eventType,resource,detail");
    expect(body).toContain("auth.login");
    expect(body).toContain("user-1");
  });

  it("should return empty CSV (header only) when no entries", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export");
    const response = await GET(request as any);

    const body = await response.text();
    const lines = body.split("\n");
    expect(lines).toHaveLength(1); // header only
    expect(lines[0]).toBe("id,timestamp,actorType,actorId,eventType,resource,detail");
  });

  it("should handle null resource field in CSV", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-02-21T10:00:00Z"),
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        resource: null,
        detail: null,
        rowHmac: "abc123",
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export");
    const response = await GET(request as any);

    const body = await response.text();
    const lines = body.split("\n");
    expect(lines).toHaveLength(2);
    // resource should be empty string, detail should be empty quoted string
    expect(lines[1]).toContain("auth.login");
  });

  it("should apply eventType filter when provided", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const { eq } = await import("drizzle-orm");
    const request = new Request("http://localhost/api/audit/export?eventType=auth.login");
    const response = await GET(request as any);

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("event_type", "auth.login");
  });

  it("should apply date range filters when provided", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const { gte, lte } = await import("drizzle-orm");
    const request = new Request("http://localhost/api/audit/export?from=2026-01-01&to=2026-02-01");
    const response = await GET(request as any);

    expect(response.status).toBe(200);
    const expectedToDate = new Date("2026-02-01");
    expectedToDate.setUTCHours(23, 59, 59, 999);
    expect(gte).toHaveBeenCalledWith("timestamp", new Date("2026-01-01"));
    expect(lte).toHaveBeenCalledWith("timestamp", expectedToDate);
  });
});

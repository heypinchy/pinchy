import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

const mockOrderBy = vi.fn();
const mockFrom = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockSelectDistinct = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock("@/db", () => ({
  db: { selectDistinct: mockSelectDistinct },
}));

vi.mock("@/db/schema", () => ({
  auditLog: { eventType: "event_type" },
}));

vi.mock("drizzle-orm", () => ({
  asc: vi.fn((col) => col),
}));

import { requireAdmin } from "@/lib/api-auth";

describe("GET /api/audit/event-types", () => {
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

    const { GET } = await import("@/app/api/audit/event-types/route");
    const response = await GET();
    expect(response.status).toBe(403);
  });

  it("should return distinct event types from the database", async () => {
    mockOrderBy.mockResolvedValue([
      { eventType: "agent.created" },
      { eventType: "auth.login" },
      { eventType: "tool.bash" },
    ]);

    const { GET } = await import("@/app/api/audit/event-types/route");
    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.eventTypes).toEqual(["agent.created", "auth.login", "tool.bash"]);
  });

  it("should return empty array when no audit entries exist", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/event-types/route");
    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.eventTypes).toEqual([]);
  });

  it("should query with selectDistinct on eventType column", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/event-types/route");
    await GET();

    expect(mockSelectDistinct).toHaveBeenCalledWith({ eventType: "event_type" });
    expect(mockFrom).toHaveBeenCalledWith(expect.anything());
  });
});

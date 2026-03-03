import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

// Build chainable mock for entries query:
// select().from().leftJoin().leftJoin().leftJoin().where().orderBy().limit().offset()
const mockEntriesOffset = vi.fn();
const mockEntriesLimit = vi.fn().mockReturnValue({ offset: mockEntriesOffset });
const mockEntriesOrderBy = vi.fn().mockReturnValue({ limit: mockEntriesLimit });
const mockEntriesWhere = vi.fn().mockReturnValue({ orderBy: mockEntriesOrderBy });
const mockEntriesLeftJoin3 = vi.fn().mockReturnValue({ where: mockEntriesWhere });
const mockEntriesLeftJoin2 = vi.fn().mockReturnValue({ leftJoin: mockEntriesLeftJoin3 });
const mockEntriesLeftJoin1 = vi.fn().mockReturnValue({ leftJoin: mockEntriesLeftJoin2 });
const mockEntriesFrom = vi.fn().mockReturnValue({ leftJoin: mockEntriesLeftJoin1 });

// Build chainable mock for count query: select().from().where()
const mockCountWhere = vi.fn();
const mockCountFrom = vi.fn().mockReturnValue({ where: mockCountWhere });

const mockSelect = vi.fn();

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
  users: {
    id: "id",
    name: "name",
    deletedAt: "deleted_at",
  },
  agents: {
    id: "id",
    name: "name",
    deletedAt: "deleted_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  desc: vi.fn((col) => col),
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  gte: vi.fn((col, val) => ({ col, val, op: "gte" })),
  lte: vi.fn((col, val) => ({ col, val, op: "lte" })),
  count: vi.fn(() => "count_fn"),
  sql: vi.fn((strings, ...values) => ({ strings, values })),
}));

vi.mock("drizzle-orm/pg-core", () => ({
  alias: vi.fn((table, _name) => table),
}));

import { requireAdmin } from "@/lib/api-auth";
import { eq } from "drizzle-orm";

// ── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/audit", () => {
  let GET: typeof import("@/app/api/audit/route").GET;

  const sampleEntries = [
    {
      id: 1,
      timestamp: "2026-02-21T10:00:00.000Z",
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      resource: null,
      detail: null,
      rowHmac: "hmac-1",
      actorName: null,
      actorDeleted: null,
      resourceAgentName: null,
      resourceAgentDeleted: null,
      resourceUserName: null,
      resourceUserDeleted: null,
    },
    {
      id: 2,
      timestamp: "2026-02-21T09:00:00.000Z",
      actorType: "user",
      actorId: "user-2",
      eventType: "config.changed",
      resource: "settings",
      detail: { key: "provider" },
      rowHmac: "hmac-2",
      actorName: null,
      actorDeleted: null,
      resourceAgentName: null,
      resourceAgentDeleted: null,
      resourceUserName: null,
      resourceUserDeleted: null,
    },
  ];

  function setupMocks(entries = sampleEntries, total = entries.length) {
    // First call: entries query (with leftJoin chain)
    mockSelect.mockReturnValueOnce({ from: mockEntriesFrom });
    mockEntriesOffset.mockResolvedValueOnce(entries);

    // Second call: count query
    mockSelect.mockReturnValueOnce({ from: mockCountFrom });
    mockCountWhere.mockResolvedValueOnce([{ count: total }]);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof requireAdmin> extends Promise<infer T> ? T : never);

    const mod = await import("@/app/api/audit/route");
    GET = mod.GET;
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const request = new NextRequest("http://localhost:7777/api/audit");
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 401 for unauthenticated users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const request = new NextRequest("http://localhost:7777/api/audit");
    const response = await GET(request);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns paginated audit entries with default pagination", async () => {
    setupMocks();

    const request = new NextRequest("http://localhost:7777/api/audit");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);

    // Verify default pagination: limit(50), offset(0)
    expect(mockEntriesLimit).toHaveBeenCalledWith(50);
    expect(mockEntriesOffset).toHaveBeenCalledWith(0);
  });

  it("supports custom page and limit parameters", async () => {
    setupMocks([], 100);

    const request = new NextRequest("http://localhost:7777/api/audit?page=3&limit=20");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.page).toBe(3);
    expect(body.limit).toBe(20);

    // offset = (page - 1) * limit = (3 - 1) * 20 = 40
    expect(mockEntriesLimit).toHaveBeenCalledWith(20);
    expect(mockEntriesOffset).toHaveBeenCalledWith(40);
  });

  it("clamps limit to max 100", async () => {
    setupMocks([]);

    const request = new NextRequest("http://localhost:7777/api/audit?limit=999");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.limit).toBe(100);

    expect(mockEntriesLimit).toHaveBeenCalledWith(100);
  });

  it("clamps limit to min 1", async () => {
    setupMocks([]);

    const request = new NextRequest("http://localhost:7777/api/audit?limit=0");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.limit).toBe(1);

    expect(mockEntriesLimit).toHaveBeenCalledWith(1);
  });

  it("clamps page to min 1", async () => {
    setupMocks([]);

    const request = new NextRequest("http://localhost:7777/api/audit?page=-5");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.page).toBe(1);

    expect(mockEntriesOffset).toHaveBeenCalledWith(0);
  });

  it("supports eventType filter parameter", async () => {
    setupMocks([sampleEntries[0]], 1);

    const request = new NextRequest("http://localhost:7777/api/audit?eventType=auth.login");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toHaveLength(1);

    // Verify eq was called with eventType column and value
    expect(eq).toHaveBeenCalledWith("event_type", "auth.login");
  });

  it("supports actorId filter parameter", async () => {
    setupMocks([sampleEntries[0]], 1);

    const request = new NextRequest("http://localhost:7777/api/audit?actorId=user-1");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("actor_id", "user-1");
  });

  it("supports from and to date range filters", async () => {
    const { gte, lte } = await import("drizzle-orm");
    setupMocks([]);

    const request = new NextRequest(
      "http://localhost:7777/api/audit?from=2026-02-01T00:00:00Z&to=2026-02-28T23:59:59Z"
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(gte).toHaveBeenCalledWith("timestamp", new Date("2026-02-01T00:00:00Z"));
    expect(lte).toHaveBeenCalledWith("timestamp", new Date("2026-02-28T23:59:59Z"));
  });

  it("sets to-date to end of UTC day when only a date string is provided", async () => {
    const { lte } = await import("drizzle-orm");
    setupMocks([]);

    const request = new NextRequest("http://localhost:7777/api/audit?to=2026-03-03");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const expectedEndOfDay = new Date("2026-03-03");
    expectedEndOfDay.setUTCHours(23, 59, 59, 999);
    expect(lte).toHaveBeenCalledWith("timestamp", expectedEndOfDay);
  });

  it("returns total count of 0 when no entries exist", async () => {
    setupMocks([], 0);

    const request = new NextRequest("http://localhost:7777/api/audit");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("resolves actorName from users table", async () => {
    const entriesWithName = [
      {
        id: 1,
        timestamp: new Date("2026-02-21T10:00:00.000Z"),
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        resource: null,
        detail: {},
        rowHmac: "abc",
        actorName: "Alice",
        actorDeleted: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserDeleted: null,
      },
    ];

    // First call: entries query
    mockSelect.mockReturnValueOnce({ from: mockEntriesFrom });
    mockEntriesOffset.mockResolvedValueOnce(entriesWithName);

    // Second call: count query
    mockSelect.mockReturnValueOnce({ from: mockCountFrom });
    mockCountWhere.mockResolvedValueOnce([{ count: 1 }]);

    const req = new NextRequest("http://localhost/api/audit");
    const res = await GET(req);
    const body = await res.json();
    expect(body.entries[0].actorName).toBe("Alice");
  });

  it("resolves resourceName from agents table when resource is agent:<id>", async () => {
    const entriesWithAgentResource = [
      {
        id: 2,
        timestamp: new Date("2026-02-21T10:00:00.000Z"),
        actorType: "user",
        actorId: "user-1",
        eventType: "agent.created",
        resource: "agent:agent-1",
        detail: {},
        rowHmac: "def",
        actorName: "Alice",
        actorDeleted: null,
        resourceAgentName: "Smithers",
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserDeleted: null,
      },
    ];

    // First call: entries query
    mockSelect.mockReturnValueOnce({ from: mockEntriesFrom });
    mockEntriesOffset.mockResolvedValueOnce(entriesWithAgentResource);

    // Second call: count query
    mockSelect.mockReturnValueOnce({ from: mockCountFrom });
    mockCountWhere.mockResolvedValueOnce([{ count: 1 }]);

    const req = new NextRequest("http://localhost/api/audit");
    const res = await GET(req);
    const body = await res.json();
    expect(body.entries[0].resourceName).toBe("Smithers");
  });

  it("sets actorDeleted to false when actorDeleted is null", async () => {
    const entries = [
      {
        id: 3,
        timestamp: new Date(),
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        resource: null,
        detail: {},
        rowHmac: "ghi",
        actorName: "Bob",
        actorDeleted: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserDeleted: null,
      },
    ];

    mockSelect.mockReturnValueOnce({ from: mockEntriesFrom });
    mockEntriesOffset.mockResolvedValueOnce(entries);
    mockSelect.mockReturnValueOnce({ from: mockCountFrom });
    mockCountWhere.mockResolvedValueOnce([{ count: 1 }]);

    const req = new NextRequest("http://localhost/api/audit");
    const res = await GET(req);
    const body = await res.json();
    expect(body.entries[0].actorDeleted).toBe(false);
  });

  it("sets actorDeleted to true when actorDeleted is a timestamp", async () => {
    const entries = [
      {
        id: 4,
        timestamp: new Date(),
        actorType: "user",
        actorId: "user-deleted",
        eventType: "auth.login",
        resource: null,
        detail: {},
        rowHmac: "jkl",
        actorName: "Deleted User",
        actorDeleted: new Date("2026-01-01"),
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserDeleted: null,
      },
    ];

    mockSelect.mockReturnValueOnce({ from: mockEntriesFrom });
    mockEntriesOffset.mockResolvedValueOnce(entries);
    mockSelect.mockReturnValueOnce({ from: mockCountFrom });
    mockCountWhere.mockResolvedValueOnce([{ count: 1 }]);

    const req = new NextRequest("http://localhost/api/audit");
    const res = await GET(req);
    const body = await res.json();
    expect(body.entries[0].actorDeleted).toBe(true);
  });

  it("resolves resourceName from users table when resource is user:<id>", async () => {
    const entries = [
      {
        ...sampleEntries[0],
        resource: "user:user-2",
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: "Charlie",
        resourceUserDeleted: null,
      },
    ];

    mockSelect.mockReturnValueOnce({ from: mockEntriesFrom });
    mockEntriesOffset.mockResolvedValueOnce(entries);
    mockSelect.mockReturnValueOnce({ from: mockCountFrom });
    mockCountWhere.mockResolvedValueOnce([{ count: 1 }]);

    const req = new NextRequest("http://localhost/api/audit");
    const res = await GET(req);
    const body = await res.json();
    expect(body.entries[0].resourceName).toBe("Charlie");
  });

  it("sets resourceDeleted to true when agent resource has deletedAt", async () => {
    const entries = [
      {
        ...sampleEntries[0],
        resource: "agent:agent-1",
        resourceAgentName: "Old Agent",
        resourceAgentDeleted: new Date("2024-01-01"),
        resourceUserName: null,
        resourceUserDeleted: null,
      },
    ];

    mockSelect.mockReturnValueOnce({ from: mockEntriesFrom });
    mockEntriesOffset.mockResolvedValueOnce(entries);
    mockSelect.mockReturnValueOnce({ from: mockCountFrom });
    mockCountWhere.mockResolvedValueOnce([{ count: 1 }]);

    const req = new NextRequest("http://localhost/api/audit");
    const res = await GET(req);
    const body = await res.json();
    expect(body.entries[0].resourceName).toBe("Old Agent");
    expect(body.entries[0].resourceDeleted).toBe(true);
  });

  it("sets resourceDeleted to true when user resource has deletedAt", async () => {
    const entries = [
      {
        ...sampleEntries[0],
        resource: "user:user-2",
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: "Deleted User",
        resourceUserDeleted: new Date("2024-06-01"),
      },
    ];

    mockSelect.mockReturnValueOnce({ from: mockEntriesFrom });
    mockEntriesOffset.mockResolvedValueOnce(entries);
    mockSelect.mockReturnValueOnce({ from: mockCountFrom });
    mockCountWhere.mockResolvedValueOnce([{ count: 1 }]);

    const req = new NextRequest("http://localhost/api/audit");
    const res = await GET(req);
    const body = await res.json();
    expect(body.entries[0].resourceName).toBe("Deleted User");
    expect(body.entries[0].resourceDeleted).toBe(true);
  });
});

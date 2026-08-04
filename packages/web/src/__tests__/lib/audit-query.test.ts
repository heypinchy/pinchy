import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockResolveActorIdMatchSet = vi.fn();
vi.mock("@/lib/audit", () => ({
  resolveActorIdMatchSet: (...args: unknown[]) => mockResolveActorIdMatchSet(...args),
}));

const mockLeftJoin3 = vi.fn().mockReturnValue({ leftJoin: "terminal" });
const mockLeftJoin2 = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin3 });
const mockLeftJoin1 = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin2 });
const mockFrom = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin1 });
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
    version: "version",
    outcome: "outcome",
    error: "error",
  },
  users: {
    id: "id",
    name: "name",
    banned: "banned",
    auditPseudonym: "audit_pseudonym",
  },
  agents: {
    id: "id",
    name: "name",
    deletedAt: "deleted_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  or: vi.fn((...args) => ({ or: args })),
  inArray: vi.fn((col, vals) => ({ col, vals, op: "inArray" })),
  gte: vi.fn((col, val) => ({ col, val, op: "gte" })),
  lte: vi.fn((col, val) => ({ col, val, op: "lte" })),
  sql: vi.fn((strings, ...values) => ({ strings, values })),
}));

vi.mock("drizzle-orm/pg-core", () => ({
  alias: vi.fn((table, _name) => table),
}));

// Dynamic imports (not a static top-level import): ESM hoists static imports
// to evaluate before any of this file's own top-level code runs, which would
// load "@/lib/audit-query" — and transitively "@/db" — before the `mock*`
// consts above are assigned, tripping their TDZ. Every other test file here
// that mocks "@/db" sidesteps this by `await import(...)`-ing the module
// under test from inside `beforeEach`/`it`, not from the top of the file.
let buildAuditFilters: typeof import("@/lib/audit-query").buildAuditFilters;
let auditSelectWithJoins: typeof import("@/lib/audit-query").auditSelectWithJoins;

describe("buildAuditFilters", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveActorIdMatchSet.mockResolvedValue(["user-1"]);
    ({ buildAuditFilters, auditSelectWithJoins } = await import("@/lib/audit-query"));
  });

  it("returns ok:true with no conditions when no params are given", async () => {
    const result = await buildAuditFilters(new URLSearchParams());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conditions).toHaveLength(0);
      expect(result.filters).toEqual({
        eventType: null,
        actorId: null,
        resource: null,
        from: null,
        to: null,
        status: null,
      });
    }
  });

  it("adds an eventType condition when eventType is given", async () => {
    const { eq } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("eventType=auth.login"));
    expect(result.ok).toBe(true);
    expect(eq).toHaveBeenCalledWith("event_type", "auth.login");
  });

  it("resolves the actorId dual-match set and adds an inArray condition", async () => {
    mockResolveActorIdMatchSet.mockResolvedValueOnce(["user-1", "pseudo-abc"]);
    const { inArray } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("actorId=user-1"));
    expect(result.ok).toBe(true);
    expect(mockResolveActorIdMatchSet).toHaveBeenCalledWith("user-1");
    expect(inArray).toHaveBeenCalledWith("actor_id", ["user-1", "pseudo-abc"]);
  });

  it("omits the resource filter by default (list route has no resource UI)", async () => {
    const { eq } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("resource=agent:a1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.resource).toBeNull();
    expect(eq).not.toHaveBeenCalledWith("resource", "agent:a1");
  });

  it("includes the resource filter when includeResource is set (export route)", async () => {
    const { eq } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("resource=agent:a1"), {
      includeResource: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.resource).toBe("agent:a1");
    expect(eq).toHaveBeenCalledWith("resource", "agent:a1");
  });

  it("treats empty-string status as no filter", async () => {
    const result = await buildAuditFilters(new URLSearchParams("status="));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.status).toBeNull();
  });

  it("silently ignores an unknown status by default (list-route behavior)", async () => {
    const { eq } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("status=oops"));
    expect(result.ok).toBe(true);
    expect(eq).not.toHaveBeenCalledWith("outcome", "oops");
  });

  it("rejects an unknown status with a 400 response when strictStatus is set (export-route behavior)", async () => {
    const result = await buildAuditFilters(new URLSearchParams("status=oops"), {
      strictStatus: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("adds a status=success/failure condition", async () => {
    const { eq } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("status=failure"));
    expect(result.ok).toBe(true);
    expect(eq).toHaveBeenCalledWith("outcome", "failure");
  });

  it("rejects an invalid 'from' date with a 400 response", async () => {
    const result = await buildAuditFilters(new URLSearchParams("from=notadate"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("rejects an invalid 'to' date with a 400 response", async () => {
    const result = await buildAuditFilters(new URLSearchParams("to=notadate"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("extends a date-only 'to' filter to end-of-day UTC", async () => {
    const { lte } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("to=2026-03-03"));
    expect(result.ok).toBe(true);
    const expected = new Date("2026-03-03");
    expected.setUTCHours(23, 59, 59, 999);
    expect(lte).toHaveBeenCalledWith("timestamp", expected);
  });

  it("does not extend a 'to' filter that already carries a time component", async () => {
    const { lte } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("to=2026-03-03T10:00:00Z"));
    expect(result.ok).toBe(true);
    expect(lte).toHaveBeenCalledWith("timestamp", new Date("2026-03-03T10:00:00Z"));
  });

  it("adds a gte condition for 'from'", async () => {
    const { gte } = await import("drizzle-orm");
    const result = await buildAuditFilters(new URLSearchParams("from=2026-01-01"));
    expect(result.ok).toBe(true);
    expect(gte).toHaveBeenCalledWith("timestamp", new Date("2026-01-01"));
  });
});

describe("auditSelectWithJoins", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ buildAuditFilters, auditSelectWithJoins } = await import("@/lib/audit-query"));
  });

  it("selects from auditLog and applies the dual actor join plus resource joins", async () => {
    const { or, eq, sql } = await import("drizzle-orm");
    auditSelectWithJoins();

    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockLeftJoin1).toHaveBeenCalledTimes(1);
    expect(or).toHaveBeenCalledWith(
      { col: "audit_pseudonym", val: "actor_id" },
      { col: "id", val: "actor_id" }
    );
    expect(eq).toHaveBeenCalledWith("audit_pseudonym", "actor_id");
    expect(eq).toHaveBeenCalledWith("id", "actor_id");
    expect(sql).toHaveBeenCalledTimes(2);
  });
});

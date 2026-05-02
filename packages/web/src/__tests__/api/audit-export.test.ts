import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit-sanitize", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/audit-sanitize")>("@/lib/audit-sanitize");
  return {
    ...actual,
    sanitizeDetail: vi.fn(actual.sanitizeDetail),
  };
});

vi.mock("@/lib/audit-pdf", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit-pdf")>("@/lib/audit-pdf");
  return {
    ...actual,
    renderAuditPdf: vi.fn(actual.renderAuditPdf),
  };
});

// Build chainable mock for select().from().leftJoin().leftJoin().leftJoin().where().orderBy()
const mockOrderBy = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockLeftJoin3 = vi.fn().mockReturnValue({ where: mockWhere });
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
  gte: vi.fn((col, val) => ({ col, val })),
  lte: vi.fn((col, val) => ({ col, val })),
  sql: vi.fn((strings, ...values) => ({ strings, values })),
}));

vi.mock("drizzle-orm/pg-core", () => ({
  alias: vi.fn((table, _name) => table),
}));

import { requireAdmin } from "@/lib/api-auth";
import { appendAuditLog } from "@/lib/audit";
import { sanitizeDetail } from "@/lib/audit-sanitize";
import { renderAuditPdf } from "@/lib/audit-pdf";

const HEADER =
  "id,timestamp,actorType,actorId,actorName,eventType,resource,resourceName,detail,version,outcome,error,rowHmac";

describe("GET /api/audit/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as ReturnType<typeof requireAdmin> extends Promise<infer T> ? T : never);
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(403);
  });

  it("returns CSV with correct headers including rowHmac, actorName, resourceName", async () => {
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
        version: 2,
        outcome: "success",
        error: null,
        actorName: "Alice",
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);

    expect(response.headers.get("Content-Type")).toBe("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain("audit-log-");

    const body = await response.text();
    expect(body).toContain(HEADER);
    expect(body).toContain("auth.login");
    expect(body).toContain("user-1");
    expect(body).toContain("Alice");
    expect(body).toContain("abc123");
  });

  it("returns empty CSV (header only) when no entries", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);

    const body = await response.text();
    const lines = body.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(HEADER);
  });

  it("includes resourceName resolved from agents table", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "user",
        actorId: "admin-1",
        eventType: "agent.updated",
        resource: "agent:agent-42",
        detail: { changes: { name: { from: "old", to: "new" } } },
        rowHmac: "h",
        version: 2,
        outcome: "success",
        error: null,
        actorName: "Carol",
        actorBanned: null,
        resourceAgentName: "Smithers",
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const body = await response.text();
    expect(body).toContain("Smithers");
    expect(body).toContain("agent:agent-42");
  });

  it("sanitizes sensitive data in detail field", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "agent",
        actorId: "agent-1",
        eventType: "tool.shell",
        resource: "agent:agent-1",
        detail: { apiKey: "sk-ant-abc123secret", command: "echo hi" },
        rowHmac: "h",
        version: 2,
        outcome: "success",
        error: null,
        actorName: null,
        actorBanned: null,
        resourceAgentName: "Smithers",
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const body = await response.text();
    expect(body).not.toContain("sk-ant-abc123secret");
    expect(body).toContain("[REDACTED]");
    expect(body).toContain("echo hi");
  });

  it("handles null resource/detail/actorName fields", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-02-21T10:00:00Z"),
        actorType: "system",
        actorId: "system",
        eventType: "auth.failed",
        resource: null,
        detail: null,
        rowHmac: "h",
        version: 2,
        outcome: "failure",
        error: { message: "bad password" },
        actorName: null,
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const body = await response.text();
    const lines = body.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("auth.failed");
    expect(lines[1]).toContain("bad password");
  });

  it("applies eventType filter when provided", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const { eq } = await import("drizzle-orm");
    const request = new Request("http://localhost/api/audit/export?eventType=auth.login");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("event_type", "auth.login");
  });

  it("applies actorId filter", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const { eq } = await import("drizzle-orm");
    const request = new Request("http://localhost/api/audit/export?actorId=user-1");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("actor_id", "user-1");
  });

  it("applies resource filter (filter by agent)", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const { eq } = await import("drizzle-orm");
    const request = new Request("http://localhost/api/audit/export?resource=agent:agent-1");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("resource", "agent:agent-1");
  });

  it("includes version/outcome/error/rowHmac for v2 failure row", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "agent",
        actorId: "agent-1",
        eventType: "tool.shell.exec",
        resource: "agent:agent-1",
        detail: {},
        rowHmac: "deadbeef",
        version: 2,
        outcome: "failure",
        error: { message: "boom" },
        actorName: null,
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);
    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const body = await response.text();
    const lines = body.split("\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toContain(',2,"failure",');
    expect(lines[1]).toContain("boom");
    expect(lines[1]).toContain("deadbeef");
  });

  it("leaves outcome/error empty for v1 rows in CSV but still includes rowHmac", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 2,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        resource: null,
        detail: null,
        rowHmac: "v1hash",
        version: 1,
        outcome: null,
        error: null,
        actorName: null,
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);
    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const body = await response.text();
    const lines = body.split("\n");
    expect(lines[1]).toContain(',1,"","",');
    expect(lines[1]).toContain("v1hash");
  });

  it("applies status=failure filter", async () => {
    mockOrderBy.mockResolvedValue([]);
    const { GET } = await import("@/app/api/audit/export/route");
    const { eq } = await import("drizzle-orm");
    const response = await GET(
      new Request("http://localhost/api/audit/export?status=failure") as unknown as Parameters<
        typeof GET
      >[0]
    );
    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("outcome", "failure");
  });

  it("applies date range filters when provided", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const { gte, lte } = await import("drizzle-orm");
    const request = new Request("http://localhost/api/audit/export?from=2026-01-01&to=2026-02-01");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    const expectedToDate = new Date("2026-02-01");
    expectedToDate.setUTCHours(23, 59, 59, 999);
    expect(gte).toHaveBeenCalledWith("timestamp", new Date("2026-01-01"));
    expect(lte).toHaveBeenCalledWith("timestamp", expectedToDate);
  });

  // ── PDF export ───────────────────────────────────────────────────────

  it("returns 403 for non-admin users (PDF format)", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export?format=pdf");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(403);
  });

  it("returns PDF when format=pdf with correct Content-Type and Content-Disposition", async () => {
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
        version: 2,
        outcome: "success",
        error: null,
        actorName: "Alice",
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    const request = new Request("http://localhost/api/audit/export?format=pdf");
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toMatch(/audit-log-.*\.pdf/);

    const buf = Buffer.from(await response.arrayBuffer());
    // PDF magic bytes
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    expect(buf.length).toBeGreaterThan(100);
  });

  it("PDF format returns empty PDF (header-only) when no entries", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export?format=pdf") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    expect(response.status).toBe(200);
    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("PDF format applies eventType filter", async () => {
    mockOrderBy.mockResolvedValue([]);
    const { GET } = await import("@/app/api/audit/export/route");
    const { eq } = await import("drizzle-orm");
    const response = await GET(
      new Request(
        "http://localhost/api/audit/export?format=pdf&eventType=auth.login"
      ) as unknown as Parameters<typeof GET>[0]
    );
    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("event_type", "auth.login");
  });

  it("rejects unknown format with 400", async () => {
    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export?format=xml") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    expect(response.status).toBe(400);
  });

  it("escapes embedded double-quotes in detail JSON", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "user",
        actorId: "user-1",
        eventType: "agent.updated",
        resource: "agent:a1",
        detail: { changes: { name: { from: "old", to: "new" } } },
        rowHmac: "h",
        version: 2,
        outcome: "success",
        error: null,
        actorName: 'O\'Brien, "the boss"',
        actorBanned: null,
        resourceAgentName: "Smithers",
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);
    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const body = await response.text();
    // detail JSON contains internal " — must be doubled inside the quoted CSV field
    expect(body).toContain('""from"":""old""');
    // actorName contains both ' and " — " must be doubled and field quoted
    expect(body).toContain('"O\'Brien, ""the boss"""');
  });

  // ── Error message sanitization ───────────────────────────────────────

  it("redacts secrets in error.message in CSV", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "agent",
        actorId: "agent-1",
        eventType: "tool.web_fetch",
        resource: "agent:agent-1",
        detail: {},
        rowHmac: "h",
        version: 2,
        outcome: "failure",
        error: {
          message: "Failed POST https://api.example.com with token sk-ant-abcdefghij1234567890XYZ",
        },
        actorName: null,
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);
    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const body = await response.text();
    expect(body).not.toContain("sk-ant-abcdefghij1234567890XYZ");
    expect(body).toContain("[REDACTED]");
  });

  // ── CSV: all textual fields are quoted (RFC 4180 robustness) ─────────

  it("quotes every textual CSV field (defends against commas in resource/eventType)", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "user",
        actorId: "user,with,commas",
        eventType: "tool.weird,name",
        resource: "settings,with,commas",
        detail: null,
        rowHmac: "h",
        version: 2,
        outcome: "success",
        error: null,
        actorName: null,
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);
    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const body = await response.text();
    expect(body).toContain('"user,with,commas"');
    expect(body).toContain('"tool.weird,name"');
    expect(body).toContain('"settings,with,commas"');
    // RFC 4180 round-trip: a quote-aware parser must yield exactly 13
    // fields for both the header and the data row, regardless of how many
    // commas appear inside quoted values.
    const parseRow = (line: string): string[] => {
      const fields: string[] = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQ && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQ = !inQ;
          }
        } else if (c === "," && !inQ) {
          fields.push(cur);
          cur = "";
        } else {
          cur += c;
        }
      }
      fields.push(cur);
      return fields;
    };
    expect(parseRow(body.split("\n")[0])).toHaveLength(13);
    expect(parseRow(body.split("\n")[1])).toHaveLength(13);
  });

  // ── Strict status validation ─────────────────────────────────────────

  it("returns 400 for unknown status value (consistent with format)", async () => {
    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export?status=oops") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    expect(response.status).toBe(400);
  });

  // ── audit.exported event ─────────────────────────────────────────────

  it("logs audit.exported event after successful CSV export", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        resource: null,
        detail: null,
        rowHmac: "h",
        version: 2,
        outcome: "success",
        error: null,
        actorName: null,
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    await GET(
      new Request(
        "http://localhost/api/audit/export?eventType=auth.login"
      ) as unknown as Parameters<typeof import("@/app/api/audit/export/route").GET>[0]
    );

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "audit.exported",
        actorType: "user",
        actorId: "admin-1",
        outcome: "success",
        detail: expect.objectContaining({
          format: "csv",
          rowCount: 1,
          filterSummary: expect.stringContaining("event=auth.login"),
        }),
      })
    );
  });

  it("logs audit.exported event after successful PDF export", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    await GET(
      new Request("http://localhost/api/audit/export?format=pdf") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "audit.exported",
        outcome: "success",
        detail: expect.objectContaining({ format: "pdf", rowCount: 0 }),
      })
    );
  });

  it("export still succeeds when audit-log infrastructure fails", async () => {
    // Audit logging is fire-and-forget: if it throws, the export must
    // still return the data. Otherwise the very compliance feature we
    // added would itself become a single point of failure for exports.
    mockOrderBy.mockResolvedValue([]);
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("DB down"));
    // Suppress the console.error the route emits in this scenario.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(HEADER);
    // The route should have logged the failure for operational visibility,
    // not silently swallowed it.
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  // ── PDF-side: error.message reaches renderer already sanitized ───────

  it("passes already-sanitized error.message to the PDF renderer", async () => {
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "agent",
        actorId: "agent-1",
        eventType: "tool.web_fetch",
        resource: "agent:agent-1",
        detail: null,
        rowHmac: "h",
        version: 2,
        outcome: "failure",
        error: {
          message: "Failed POST https://api.example.com with token sk-ant-abcdefghij1234567890XYZ",
        },
        actorName: null,
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);

    const { GET } = await import("@/app/api/audit/export/route");
    await GET(
      new Request("http://localhost/api/audit/export?format=pdf") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );

    expect(renderAuditPdf).toHaveBeenCalledTimes(1);
    const passedRows = vi.mocked(renderAuditPdf).mock.calls[0][0];
    expect(passedRows[0].error?.message).not.toContain("sk-ant-abcdefghij1234567890XYZ");
    expect(passedRows[0].error?.message).toContain("[REDACTED]");
  });

  // ── Empty-string status param is treated as no filter ────────────────

  it("treats empty ?status= as no filter (returns 200, not 400)", async () => {
    mockOrderBy.mockResolvedValue([]);
    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export?status=") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    expect(response.status).toBe(200);
  });

  it("does not log audit.exported when format is invalid (400 path)", async () => {
    const { GET } = await import("@/app/api/audit/export/route");
    await GET(
      new Request("http://localhost/api/audit/export?format=xml") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  // ── Filename includes time so re-exports don't overwrite ─────────────

  it("filename includes hour-minute timestamp", async () => {
    mockOrderBy.mockResolvedValue([]);

    const { GET } = await import("@/app/api/audit/export/route");
    const response = await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    const disposition = response.headers.get("Content-Disposition") ?? "";
    // Expect pattern audit-log-YYYY-MM-DD-HHMM.csv
    expect(disposition).toMatch(/audit-log-\d{4}-\d{2}-\d{2}-\d{4}\.csv/);
  });

  // ── Sanitize is actually invoked (regression guard) ──────────────────

  it("invokes sanitizeDetail on detail (regression guard)", async () => {
    vi.mocked(sanitizeDetail).mockClear();
    mockOrderBy.mockResolvedValue([
      {
        id: 1,
        timestamp: new Date("2026-03-01T10:00:00Z"),
        actorType: "user",
        actorId: "u1",
        eventType: "auth.login",
        resource: null,
        detail: { foo: "bar" },
        rowHmac: "h",
        version: 2,
        outcome: "success",
        error: null,
        actorName: null,
        actorBanned: null,
        resourceAgentName: null,
        resourceAgentDeleted: null,
        resourceUserName: null,
        resourceUserBanned: null,
      },
    ]);
    const { GET } = await import("@/app/api/audit/export/route");
    await GET(
      new Request("http://localhost/api/audit/export") as unknown as Parameters<
        typeof import("@/app/api/audit/export/route").GET
      >[0]
    );
    expect(sanitizeDetail).toHaveBeenCalled();
  });
});

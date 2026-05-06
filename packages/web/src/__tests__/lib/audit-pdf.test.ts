import { describe, it, expect } from "vitest";
import {
  renderAuditPdf,
  buildFilterSummary,
  formatActor,
  formatResource,
  type AuditExportRow,
} from "@/lib/audit-pdf";

function makeRow(overrides: Partial<AuditExportRow> = {}): AuditExportRow {
  return {
    id: 1,
    timestamp: new Date("2026-02-21T10:00:00Z"),
    actorType: "user",
    actorId: "user-1",
    actorName: "Alice",
    eventType: "auth.login",
    resource: null,
    resourceName: null,
    detail: { email: "alice@example.com" },
    version: 2,
    outcome: "success",
    error: null,
    rowHmac: "abc123def456",
    ...overrides,
  };
}

describe("buildFilterSummary", () => {
  it("returns 'All entries' when filters are undefined", () => {
    expect(buildFilterSummary(undefined)).toBe("All entries");
  });

  it("returns 'All entries' when all filter fields are null/empty", () => {
    expect(
      buildFilterSummary({
        eventType: null,
        actorId: null,
        resource: null,
        from: null,
        to: null,
        status: null,
      })
    ).toBe("All entries");
  });

  it("formats individual filters", () => {
    expect(buildFilterSummary({ eventType: "auth.login" })).toContain("event=auth.login");
    expect(buildFilterSummary({ actorId: "user-1" })).toContain("actor=user-1");
    expect(buildFilterSummary({ resource: "agent:a1" })).toContain("resource=agent:a1");
    expect(buildFilterSummary({ status: "failure" })).toContain("status=failure");
  });

  it("trims ISO timestamps to date portion", () => {
    expect(
      buildFilterSummary({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T23:59:59.999Z" })
    ).toBe("from=2026-01-01, to=2026-01-31");
  });

  it("combines multiple filters with comma separator", () => {
    expect(
      buildFilterSummary({
        eventType: "auth.login",
        from: "2026-01-01",
        to: "2026-01-31",
      })
    ).toBe("event=auth.login, from=2026-01-01, to=2026-01-31");
  });
});

describe("formatActor", () => {
  it("returns actorName when present", () => {
    expect(formatActor(makeRow({ actorName: "Alice" }))).toBe("Alice");
  });

  it("falls back to truncated actorId when name is null", () => {
    expect(formatActor(makeRow({ actorName: null, actorId: "system-bot-uuid-123456" }))).toBe(
      "system-b…"
    );
  });

  it("uses full id when shorter than 9 chars", () => {
    expect(formatActor(makeRow({ actorName: null, actorId: "system" }))).toBe("system");
  });
});

describe("formatResource", () => {
  it("returns resourceName when present", () => {
    expect(formatResource(makeRow({ resourceName: "Smithers" }))).toBe("Smithers");
  });

  it("returns em-dash when resource is null", () => {
    expect(formatResource(makeRow({ resource: null, resourceName: null }))).toBe("—");
  });

  it("falls back to truncated resource id", () => {
    const longResource = "agent:" + "x".repeat(100);
    const result = formatResource(makeRow({ resource: longResource, resourceName: null }));
    expect(result.length).toBeLessThanOrEqual(31);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("renderAuditPdf", () => {
  it("returns a Buffer with PDF magic bytes", async () => {
    const buf = await renderAuditPdf([makeRow()]);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders an empty PDF for zero rows", async () => {
    const buf = await renderAuditPdf([]);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    expect(buf.length).toBeGreaterThan(100);
  });

  it("does not crash on multi-page output", async () => {
    const manyRows = Array.from({ length: 200 }, (_, i) =>
      makeRow({ id: i, eventType: i % 2 === 0 ? "auth.login" : "auth.failed" })
    );
    const buf = await renderAuditPdf(manyRows);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("does not crash with failure rows that have error messages", async () => {
    const buf = await renderAuditPdf([
      makeRow({
        outcome: "failure",
        eventType: "auth.failed",
        error: { message: "wrong password" },
      }),
    ]);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("encodes report title in PDF metadata", async () => {
    const buf = await renderAuditPdf([makeRow()]);
    // PDF metadata is stored uncompressed in the trailer/Info dictionary
    const text = buf.toString("latin1");
    expect(text).toContain("Pinchy Audit Trail Report");
  });
});

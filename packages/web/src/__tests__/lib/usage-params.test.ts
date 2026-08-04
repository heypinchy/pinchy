import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { and, eq, gte, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { parseDays, resolveUsageFilter } from "@/lib/usage-params";
import { usageRecords } from "@/db/schema";

describe("parseDays", () => {
  it("should default to 30 when param is null", () => {
    expect(parseDays(null)).toBe(30);
  });

  it('should parse "30" as 30', () => {
    expect(parseDays("30")).toBe(30);
  });

  it('should parse "7" as 7', () => {
    expect(parseDays("7")).toBe(7);
  });

  it('should parse "90" as 90', () => {
    expect(parseDays("90")).toBe(90);
  });

  it('should return 0 for "0" (all time)', () => {
    expect(parseDays("0")).toBe(0);
  });

  it('should return 0 for "all" (all time)', () => {
    expect(parseDays("all")).toBe(0);
  });

  it("should return a 400 NextResponse for non-numeric input", () => {
    const result = parseDays("abc");
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it("should return a 400 NextResponse for negative numbers", () => {
    const result = parseDays("-5");
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it("should default to 30 for empty string (falsy)", () => {
    expect(parseDays("")).toBe(30);
  });
});

// resolveUsageFilter is the days+agentId → drizzle `where` clause that
// by-user, summary, export, and timeseries now share instead of each
// re-implementing "gte(timestamp, since) AND eq(agentId, ...)" inline. The
// assertions below render each SQL node to its parameterised query string
// (dialect-independent — no DB connection needed) rather than deep-comparing
// drizzle's internal object graph, which nests differently depending on how
// many conditions are ANDed together.
describe("resolveUsageFilter", () => {
  function url(params: Record<string, string>) {
    const u = new URL("http://localhost/api/usage/summary");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  }

  function render(node: unknown) {
    return new PgDialect().sqlToQuery(node as SQL);
  }

  it("propagates a parseDays error as a NextResponse", () => {
    const result = resolveUsageFilter(url({ days: "abc" }));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it("returns where: undefined when days is 'all' and no agentId is given", () => {
    const result = resolveUsageFilter(url({ days: "all" }));
    expect(result).not.toBeInstanceOf(NextResponse);
    const filter = result as Exclude<typeof result, NextResponse>;
    expect(filter.days).toBe(0);
    expect(filter.agentId).toBeNull();
    expect(filter.where).toBeUndefined();
  });

  it("builds a gte(timestamp, since) condition when days > 0, since ~= now - days", () => {
    const before = new Date();
    const result = resolveUsageFilter(url({ days: "7" }));
    const after = new Date();
    expect(result).not.toBeInstanceOf(NextResponse);
    const filter = result as Exclude<typeof result, NextResponse>;
    expect(filter.days).toBe(7);

    const rendered = render(filter.where);
    expect(rendered.sql).toBe(render(and(gte(usageRecords.timestamp, new Date()))).sql);
    const since = new Date(rendered.params[0] as string);
    const expectedFloor = new Date(before);
    expectedFloor.setDate(expectedFloor.getDate() - 7);
    const expectedCeil = new Date(after);
    expectedCeil.setDate(expectedCeil.getDate() - 7);
    expect(since.getTime()).toBeGreaterThanOrEqual(expectedFloor.getTime());
    expect(since.getTime()).toBeLessThanOrEqual(expectedCeil.getTime());
  });

  it("filters by agentId alone when days is 'all'", () => {
    const result = resolveUsageFilter(url({ days: "all", agentId: "agent-2" }));
    const filter = result as Exclude<typeof result, NextResponse>;
    const rendered = render(filter.where);
    expect(rendered).toEqual(render(and(eq(usageRecords.agentId, "agent-2"))));
  });

  it("combines days and agentId with AND when both are present", () => {
    const result = resolveUsageFilter(url({ days: "7", agentId: "agent-3" }));
    const filter = result as Exclude<typeof result, NextResponse>;
    const rendered = render(filter.where);
    // Same SQL text shape as a direct and(gte(...), eq(...)) call — two `$N`
    // placeholders, timestamp compared before agentId.
    expect(rendered.sql).toBe(
      render(and(gte(usageRecords.timestamp, new Date()), eq(usageRecords.agentId, "agent-3"))).sql
    );
    expect(rendered.params[1]).toBe("agent-3");
  });
});

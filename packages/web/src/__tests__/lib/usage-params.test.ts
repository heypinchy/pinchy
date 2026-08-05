import { describe, it, expect, afterEach, vi } from "vitest";
import { NextResponse } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { parseDays, parseUsageFilter } from "@/lib/usage-params";

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

/**
 * The four usage read routes (summary, by-user, export, timeseries) share this
 * one filter since #1087. It is tested here rather than only through the routes
 * because the thing worth pinning is not a status code but *which rows an admin
 * sees* — and the route tests each assert their own response shape, so a filter
 * that quietly stopped applying `agentId` would still look right in all four.
 *
 * The assertions read the rendered SQL rather than the SQL object's internals:
 * what matters is the predicate Postgres receives.
 */
describe("parseUsageFilter", () => {
  const dialect = new PgDialect();

  /** Render a drizzle condition the way the driver would. */
  function rendered(where: SQL | undefined) {
    if (!where) throw new Error("expected a WHERE clause");
    return dialect.sqlToQuery(where);
  }

  function filterFor(query: string) {
    const result = parseUsageFilter(new URL(`http://localhost/api/usage/summary${query}`));
    if (result instanceof NextResponse) throw new Error("expected a filter, got a response");
    return result;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a bad `days` straight back as the 400 response", () => {
    const result = parseUsageFilter(new URL("http://localhost/api/usage/summary?days=abc"));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it("applies no WHERE at all for days=0 without an agentId", () => {
    const filter = filterFor("?days=0");
    expect(filter.days).toBe(0);
    expect(filter.agentId).toBeNull();
    // undefined, not an empty and(): drizzle reads that as "select everything".
    expect(filter.where).toBeUndefined();
  });

  it("bounds the timestamp at exactly `days` before now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));

    const { sql, params } = rendered(filterFor("?days=7").where);
    expect(sql).toContain('"timestamp" >=');
    // Drizzle's timestamp mapper hands the driver an ISO string, not the Date.
    expect(params).toEqual(["2026-07-29T12:00:00.000Z"]);
  });

  it("filters by agent alone when days=0", () => {
    const filter = filterFor("?days=0&agentId=agent-1");
    const { sql, params } = rendered(filter.where);
    expect(sql).toContain('"agent_id" =');
    expect(sql).not.toContain('"timestamp"');
    expect(params).toEqual(["agent-1"]);
  });

  it("ands both conditions together when both apply", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));

    const { sql, params } = rendered(filterFor("?days=30&agentId=agent-1").where);
    expect(sql).toContain('"timestamp" >=');
    expect(sql).toContain('"agent_id" =');
    expect(params).toEqual(["2026-07-06T12:00:00.000Z", "agent-1"]);
  });

  it("defaults to the last 30 days when no params are given", () => {
    const filter = filterFor("");
    expect(filter.days).toBe(30);
    expect(rendered(filter.where).sql).toContain('"timestamp" >=');
  });
});

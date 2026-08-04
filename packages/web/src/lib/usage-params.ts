import { NextResponse } from "next/server";
import { and, eq, gte, type SQL } from "drizzle-orm";
import { usageRecords } from "@/db/schema";

/**
 * Parse and validate the `days` query parameter from a usage API request.
 * Returns the number of days to look back (0 = all time), or a NextResponse error.
 */
export function parseDays(daysParam: string | null): number | NextResponse {
  const raw = daysParam || "30";
  if (raw === "all" || raw === "0") return 0;
  const days = parseInt(raw, 10);
  if (isNaN(days) || days < 0) {
    return NextResponse.json({ error: "Invalid days parameter" }, { status: 400 });
  }
  return days;
}

export interface UsageFilter {
  days: number;
  agentId: string | null;
  where: SQL | undefined;
}

/**
 * Every usage route (by-user, summary, export, timeseries) filters
 * `usageRecords` the same way: `days` (0 = all time) plus an optional
 * `agentId`. Shared here so the four copies can't drift on what counts as
 * "since" or how an empty filter collapses to `undefined`.
 */
export function resolveUsageFilter(url: URL): UsageFilter | NextResponse {
  const daysOrError = parseDays(url.searchParams.get("days"));
  if (daysOrError instanceof NextResponse) return daysOrError;
  const days = daysOrError;
  const agentId = url.searchParams.get("agentId");

  const conditions: SQL[] = [];
  if (days > 0) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    conditions.push(gte(usageRecords.timestamp, since));
  }
  if (agentId) {
    conditions.push(eq(usageRecords.agentId, agentId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return { days, agentId, where };
}

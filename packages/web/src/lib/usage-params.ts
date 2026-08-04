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
  /** Days to look back; 0 means all time (no lower bound on `timestamp`). */
  days: number;
  agentId: string | null;
  /** `undefined` when neither filter applies — drizzle reads that as "no WHERE". */
  where: SQL | undefined;
}

/**
 * The `days` + `agentId` filter every usage route applies to `usage_records`.
 *
 * Single-sourced because all four read routes (`summary`, `by-user`, `export`,
 * `timeseries`) carried a byte-identical copy of it (#1087), and a filter that
 * drifts between them silently answers the same question two different ways —
 * an export that disagrees with the summary above it is a data-integrity bug,
 * not a cosmetic one.
 *
 * Returns the caller's 400 response unchanged when `days` is unparseable.
 */
export function parseUsageFilter(url: URL): UsageFilter | NextResponse {
  const days = parseDays(url.searchParams.get("days"));
  if (days instanceof NextResponse) return days;

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

  return { days, agentId, where: conditions.length > 0 ? and(...conditions) : undefined };
}

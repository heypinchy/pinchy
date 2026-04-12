import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { parseDays } from "@/lib/usage-params";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { sql, sum, gte, eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const url = new URL(request.url);
  const daysOrError = parseDays(url.searchParams.get("days"));
  if (daysOrError instanceof NextResponse) return daysOrError;
  const days = daysOrError;
  const agentId = url.searchParams.get("agentId");
  const tz = url.searchParams.get("tz");

  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
    }
  }

  const conditions = [];
  if (days > 0) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    conditions.push(gte(usageRecords.timestamp, since));
  }
  if (agentId) {
    conditions.push(eq(usageRecords.agentId, agentId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const dateExpr = tz
    ? sql<string>`date_trunc('day', ${usageRecords.timestamp} AT TIME ZONE ${tz})::date`
    : sql<string>`date_trunc('day', ${usageRecords.timestamp})::date`;

  const data = await db
    .select({
      date: dateExpr,
      inputTokens: sum(usageRecords.inputTokens),
      outputTokens: sum(usageRecords.outputTokens),
      cacheReadTokens: sum(usageRecords.cacheReadTokens),
      cacheWriteTokens: sum(usageRecords.cacheWriteTokens),
      cost: sum(usageRecords.estimatedCostUsd),
    })
    .from(usageRecords)
    .where(where)
    .groupBy(dateExpr)
    .orderBy(dateExpr);

  return NextResponse.json({ data: zeroFill(data) });
}

function zeroFill(
  rows: {
    date: string;
    inputTokens: string | null;
    outputTokens: string | null;
    cacheReadTokens: string | null;
    cacheWriteTokens: string | null;
    cost: string | null;
  }[]
) {
  if (rows.length < 2) return rows;

  const map = new Map(rows.map((r) => [String(r.date), r]));
  const filled: typeof rows = [];
  const start = new Date(String(rows[0].date));
  const end = new Date(String(rows[rows.length - 1].date));

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    filled.push(
      map.get(key) ?? {
        date: key,
        inputTokens: "0",
        outputTokens: "0",
        cacheReadTokens: "0",
        cacheWriteTokens: "0",
        cost: null,
      }
    );
  }
  return filled;
}

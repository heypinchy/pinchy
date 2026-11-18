import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { parseUsageFilter } from "@/lib/usage-params";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { sql, sum } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const url = new URL(request.url);
  const filter = parseUsageFilter(url);
  if (filter instanceof NextResponse) return filter;
  const { where } = filter;

  const tz = url.searchParams.get("tz");
  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
    }
  }

  // Use sql.raw for the timezone identifier — it's already validated above via
  // Intl.DateTimeFormat and only contains [A-Za-z/_+-] characters. A parameterised
  // ${tz} would create a fresh $N placeholder each time dateExpr is referenced
  // (SELECT, GROUP BY, ORDER BY), making PostgreSQL see three different expressions
  // and reject the query with "must appear in the GROUP BY clause".
  const dateExpr = tz
    ? sql<string>`date_trunc('day', ${usageRecords.timestamp} AT TIME ZONE '${sql.raw(tz)}')::date`
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

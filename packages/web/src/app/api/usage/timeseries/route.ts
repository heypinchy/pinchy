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

  const dateExpr = sql<string>`date_trunc('day', ${usageRecords.timestamp})::date`;

  const data = await db
    .select({
      date: dateExpr,
      inputTokens: sum(usageRecords.inputTokens),
      outputTokens: sum(usageRecords.outputTokens),
      cost: sum(usageRecords.estimatedCostUsd),
    })
    .from(usageRecords)
    .where(where)
    .groupBy(dateExpr)
    .orderBy(dateExpr);

  return NextResponse.json({ data });
}

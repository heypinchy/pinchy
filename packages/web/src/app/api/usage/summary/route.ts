import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { sum, max, gte, eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const url = new URL(request.url);
  const daysParam = url.searchParams.get("days") || "30";
  const days = daysParam === "all" ? 0 : parseInt(daysParam);
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

  const agents = await db
    .select({
      agentId: usageRecords.agentId,
      agentName: max(usageRecords.agentName),
      totalInputTokens: sum(usageRecords.inputTokens),
      totalOutputTokens: sum(usageRecords.outputTokens),
      totalCost: sum(usageRecords.estimatedCostUsd),
    })
    .from(usageRecords)
    .where(where)
    .groupBy(usageRecords.agentId);

  return NextResponse.json({ agents });
}

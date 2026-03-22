import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { usageRecords, users } from "@/db/schema";
import { sum, gte, eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

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

  const result = await db
    .select({
      userId: usageRecords.userId,
      userName: users.name,
      totalInputTokens: sum(usageRecords.inputTokens),
      totalOutputTokens: sum(usageRecords.outputTokens),
      totalCost: sum(usageRecords.estimatedCostUsd),
    })
    .from(usageRecords)
    .leftJoin(users, eq(users.id, usageRecords.userId))
    .where(where)
    .groupBy(usageRecords.userId, users.name);

  return NextResponse.json({ users: result });
}

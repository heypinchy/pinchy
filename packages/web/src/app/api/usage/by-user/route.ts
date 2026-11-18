import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { parseUsageFilter } from "@/lib/usage-params";
import { db } from "@/db";
import { usageRecords, users } from "@/db/schema";
import { sum, eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const url = new URL(request.url);
  const filter = parseUsageFilter(url);
  if (filter instanceof NextResponse) return filter;
  const { where } = filter;

  const result = await db
    .select({
      userId: usageRecords.userId,
      userName: users.name,
      totalInputTokens: sum(usageRecords.inputTokens),
      totalOutputTokens: sum(usageRecords.outputTokens),
      totalCacheReadTokens: sum(usageRecords.cacheReadTokens),
      totalCacheWriteTokens: sum(usageRecords.cacheWriteTokens),
      totalCost: sum(usageRecords.estimatedCostUsd),
    })
    .from(usageRecords)
    .leftJoin(users, eq(users.id, usageRecords.userId))
    .where(where)
    .groupBy(usageRecords.userId, users.name);

  return NextResponse.json({ users: result });
}

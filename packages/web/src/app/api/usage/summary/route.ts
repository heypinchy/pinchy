import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { parseDays } from "@/lib/usage-params";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { max, sum, gte, eq, and, sql } from "drizzle-orm";
import type { UsageSource } from "@/lib/usage-source";

type SourceBucket = {
  inputTokens: string;
  outputTokens: string;
  cost: string;
};

const ZERO_BUCKET: SourceBucket = {
  inputTokens: "0",
  outputTokens: "0",
  cost: "0",
};

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

  // max(agentName) returns the lexicographically greatest name.
  // If an agent is renamed, this may show either old or new name
  // until all old records age out. Acceptable trade-off for simplicity.
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

  // Source breakdown — classify each row by its sessionKey shape and sum
  // tokens/cost per bucket. SQL can't call our TypeScript classifier, so
  // we mirror its rules as a CASE expression. Keep in sync with
  // packages/web/src/lib/usage-source.ts.
  const sourceExpr = sql<UsageSource>`CASE
    WHEN ${usageRecords.sessionKey} LIKE 'plugin:%' THEN 'plugin'
    WHEN ${usageRecords.sessionKey} LIKE 'agent:%:direct:%' THEN 'chat'
    ELSE 'system'
  END`;

  const bySource = await db
    .select({
      source: sourceExpr,
      inputTokens: sum(usageRecords.inputTokens),
      outputTokens: sum(usageRecords.outputTokens),
      cost: sum(usageRecords.estimatedCostUsd),
    })
    .from(usageRecords)
    .where(where)
    .groupBy(sourceExpr);

  const totals: Record<UsageSource, SourceBucket> = {
    chat: { ...ZERO_BUCKET },
    system: { ...ZERO_BUCKET },
    plugin: { ...ZERO_BUCKET },
  };
  for (const row of bySource) {
    totals[row.source] = {
      inputTokens: row.inputTokens ?? "0",
      outputTokens: row.outputTokens ?? "0",
      cost: row.cost ?? "0",
    };
  }

  return NextResponse.json({ agents, totals });
}

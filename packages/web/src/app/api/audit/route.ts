import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { desc, and, count } from "drizzle-orm";
import { apiKeyActorName } from "@/lib/api-key-identity";
import { buildAuditFilters, auditSelectWithJoins } from "@/lib/audit-query";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const url = new URL(request.url);
  // parseInt yields NaN on non-numeric input; Math.max(1, NaN) is NaN, which
  // would propagate into the SQL offset. Fall back to the default instead.
  const pageRaw = parseInt(url.searchParams.get("page") || "1", 10);
  const page = Number.isNaN(pageRaw) ? 1 : Math.max(1, pageRaw);
  const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Number.isNaN(limitRaw) ? 50 : Math.min(100, Math.max(1, limitRaw));

  const filtersResult = await buildAuditFilters(url.searchParams);
  if (!filtersResult.ok) return filtersResult.response;
  const { conditions } = filtersResult;

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [entries, totalResult] = await Promise.all([
    auditSelectWithJoins()
      .where(where)
      .orderBy(desc(auditLog.timestamp))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: count() }).from(auditLog).where(where),
  ]);

  const processedEntries = entries.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    actorType: e.actorType,
    actorId: e.actorId,
    actorName: e.actorName ?? apiKeyActorName(e.actorType, e.detail),
    actorDeleted: !!e.actorBanned,
    eventType: e.eventType,
    resource: e.resource,
    resourceName: e.resourceAgentName ?? e.resourceUserName ?? null,
    resourceDeleted: !!(e.resourceAgentDeleted ?? e.resourceUserBanned ?? false),
    detail: e.detail,
    rowHmac: e.rowHmac,
    version: e.version,
    outcome: e.outcome,
    error: e.error,
  }));

  return NextResponse.json(
    {
      entries: processedEntries,
      total: totalResult[0]?.count ?? 0,
      page,
      limit,
    },
    {
      // The audit trail is the security/compliance record of admin actions,
      // so it is never cached: an admin refreshing to confirm an action was
      // logged must always see fresh data, and a sensitive log should not be
      // persisted to the browser disk cache. (Unlike /api/agents, whose short
      // private TTL absorbs navigation — the audit log's freshness wins.) #261
      headers: { "Cache-Control": "no-store" },
    }
  );
}

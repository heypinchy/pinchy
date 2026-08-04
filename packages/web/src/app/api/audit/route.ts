import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { desc, and, count, sql, type SQL } from "drizzle-orm";
import { apiKeyActorName } from "@/lib/api-key-identity";
import { buildAuditFilters, auditSelectWithJoins } from "@/lib/audit-query";

/**
 * Total is only ever (re)computed on page 1 — deep-page navigation (Previous
 * / Next) would otherwise pay for a count/estimate query on every click even
 * though the number can't have changed since the page-1 fetch that started
 * the session. The client (`audit-log-table.tsx`) keeps the page-1 total in
 * state and doesn't overwrite it when a later response omits the field.
 *
 * Returns the RAW total/estimate, without the entries.length floor applied
 * below — that keeps this query independent of the entries query so both can
 * still run concurrently via Promise.all.
 */
async function rawTotalForPage1(where: SQL | undefined): Promise<number> {
  if (where) {
    // Filtered: an exact count is the honest answer, and filters typically
    // narrow the row set enough that the scan is cheap.
    const result = await db.select({ count: count() }).from(auditLog).where(where);
    return result[0]?.count ?? 0;
  }

  // Unfiltered: audit_log is append-only and can grow unbounded, so an exact
  // count(*) here means a full-table scan on every page-1 view. Read
  // Postgres's own planner statistic instead — a single index lookup
  // regardless of table size.
  //
  // This is an ESTIMATE, not an exact count: pg_class.reltuples is only
  // refreshed by ANALYZE/VACUUM, so a table that has never been analyzed yet
  // (a brand-new install, before autovacuum's first pass) reports 0, and a
  // recent burst of inserts can leave the number stale for up to one
  // autovacuum cycle. The caller floors this against the page's own entry
  // count, so the total can never read as less than what the admin is
  // already looking at.
  const estimateRows = await db.execute<{ estimate: string | number | null }>(
    sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = 'audit_log'::regclass`
  );
  const raw = estimateRows[0]?.estimate;
  return raw === null || raw === undefined ? 0 : Number(raw);
}

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

  const [entries, rawTotal] = await Promise.all([
    auditSelectWithJoins()
      .where(where)
      .orderBy(desc(auditLog.timestamp))
      .limit(limit)
      .offset((page - 1) * limit),
    // Only computed on page 1 — see rawTotalForPage1's own comment.
    page === 1 ? rawTotalForPage1(where) : Promise.resolve(undefined),
  ]);

  // Floored against entries.length here (rather than inside rawTotalForPage1)
  // so the count/estimate query above can still run concurrently with the
  // entries query instead of waiting on it.
  const responseTotal = rawTotal === undefined ? undefined : Math.max(rawTotal, entries.length);

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
      // Omitted (not null/0) on page > 1 — see rawTotalForPage1's comment.
      // JSON.stringify drops an `undefined` property entirely, so the client
      // sees no `total` key at all rather than a misleading value.
      ...(responseTotal === undefined ? {} : { total: responseTotal }),
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

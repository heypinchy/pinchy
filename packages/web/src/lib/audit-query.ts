// Shared query-building for the two audit-log read routes: the paginated
// GET /api/audit and the unpaginated GET /api/audit/export. Both need the
// exact same filter parsing (including the from/to end-of-day rule and the
// invalid-date 400s) and the exact same select/join shape — the two used to
// carry byte-identical copies of both. `resource` is export-only: the list
// UI has no resource filter control, so keeping it export-only here mirrors
// the routes' actual behavior rather than widening the list route silently.
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog, users, agents } from "@/db/schema";
import { eq, or, inArray, gte, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { resolveActorIdMatchSet } from "@/lib/audit";

// GET /api/audit/export is the one route that reads the WHOLE matching set
// (no pagination) into memory for CSV/PDF assembly: 3 LEFT JOINs, ORDER BY,
// then a heap-resident string/PDF build. `audit_log` grows unbounded, so a
// filterless export is an OOM risk in the default 1 GB container. Mirrors
// `MAX_EXPORT_ROWS` in app/api/usage/export/route.ts. Export-only: the
// paginated list route already bounds its own query via `limit`/`offset`.
export const MAX_AUDIT_EXPORT_ROWS = 100_000;

export type AuditQueryFilters = {
  eventType: string | null;
  actorId: string | null;
  resource: string | null;
  from: string | null;
  to: string | null;
  status: "success" | "failure" | null;
};

export type BuildAuditFiltersOptions = {
  /** export-only: the list route (`/api/audit`) has no resource filter UI. */
  includeResource?: boolean;
  /**
   * export-only: reject an unrecognized `status` value with a 400 instead of
   * silently ignoring it. The two routes genuinely disagree here — the list
   * route has always treated a garbage `status` as "no filter" (a UI select
   * can't produce one), while the export route is a directly-scriptable URL
   * where a typo should be reported rather than silently returning
   * everything. Keep this a real behavioral knob, not a bug to unify away.
   */
  strictStatus?: boolean;
};

export type AuditFiltersResult =
  | { ok: true; conditions: SQL[]; filters: AuditQueryFilters }
  | { ok: false; response: NextResponse };

/**
 * Parse and validate the shared audit query params, returning either the
 * drizzle conditions to `and(...)` together plus the raw filter values (for
 * echoing back in a filter summary), or a ready-to-return 400 response.
 */
export async function buildAuditFilters(
  searchParams: URLSearchParams,
  options: BuildAuditFiltersOptions = {}
): Promise<AuditFiltersResult> {
  // Treat empty-string `status=` the same as an absent param — common when
  // forms serialize unset selects as `?status=`.
  const statusRaw = searchParams.get("status");
  const status = statusRaw === "" ? null : statusRaw;
  if (options.strictStatus && status !== null && status !== "success" && status !== "failure") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Unsupported status '${status}'. Use 'success' or 'failure'.` },
        { status: 400 }
      ),
    };
  }

  const eventType = searchParams.get("eventType");
  const actorId = searchParams.get("actorId");
  const resource = options.includeResource ? searchParams.get("resource") : null;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const conditions: SQL[] = [];
  if (eventType) conditions.push(eq(auditLog.eventType, eventType));
  if (actorId) {
    // Dual match (alt+neu): appendAuditLog substitutes the user's
    // auditPseudonym for actorId (GDPR crypto-erasure, see lib/audit.ts).
    // Filtering by a known user id must match both the raw id (pre-feature
    // rows, or a since-erased user) and the current pseudonym (post-feature
    // rows).
    const actorIdMatchSet = await resolveActorIdMatchSet(actorId);
    conditions.push(inArray(auditLog.actorId, actorIdMatchSet));
  }
  if (resource) conditions.push(eq(auditLog.resource, resource));
  if (status === "success" || status === "failure") {
    // Note: this implicitly excludes v1 (legacy) rows, which have outcome=NULL.
    // v1 rows predate status tracking — there's no honest "success" for them.
    conditions.push(eq(auditLog.outcome, status));
  }
  // A non-date string becomes an Invalid Date that drizzle throws on at
  // serialization — an unhandled 500 for a mistyped filter. Reject with a 400.
  if (from) {
    const fromDate = new Date(from);
    if (Number.isNaN(fromDate.getTime())) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Invalid 'from' date" }, { status: 400 }),
      };
    }
    conditions.push(gte(auditLog.timestamp, fromDate));
  }
  if (to) {
    const toDate = new Date(to);
    if (Number.isNaN(toDate.getTime())) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Invalid 'to' date" }, { status: 400 }),
      };
    }
    if (!to.includes("T") && !to.includes(" ")) toDate.setUTCHours(23, 59, 59, 999);
    conditions.push(lte(auditLog.timestamp, toDate));
  }

  const normalizedStatus: "success" | "failure" | null =
    status === "success" || status === "failure" ? status : null;

  return {
    ok: true,
    conditions,
    filters: { eventType, actorId, resource, from, to, status: normalizedStatus },
  };
}

/**
 * The shared select projection + dual-join (alt+neu) shape both routes need.
 * Returns the query builder BEFORE `.where()`/`.orderBy()`/pagination so
 * callers can finish it however they need (the list route adds
 * `.limit().offset()`; the export route adds a hard row cap instead).
 */
export function auditSelectWithJoins() {
  const actorUser = alias(users, "actor_user");
  const resourceAgent = alias(agents, "resource_agent");
  const resourceUser = alias(users, "resource_user");

  return (
    db
      .select({
        id: auditLog.id,
        timestamp: auditLog.timestamp,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        eventType: auditLog.eventType,
        resource: auditLog.resource,
        detail: auditLog.detail,
        rowHmac: auditLog.rowHmac,
        version: auditLog.version,
        outcome: auditLog.outcome,
        error: auditLog.error,
        actorName: actorUser.name,
        actorBanned: actorUser.banned,
        resourceAgentName: resourceAgent.name,
        resourceAgentDeleted: resourceAgent.deletedAt,
        resourceUserName: resourceUser.name,
        resourceUserBanned: resourceUser.banned,
      })
      .from(auditLog)
      // Dual-join (alt+neu): actorId may hold either the user's auditPseudonym
      // (rows written after this feature shipped) or the raw users.id (rows
      // written before, or before the substitution's own fallback path). A
      // single-shape join would leave one generation of rows nameless.
      .leftJoin(
        actorUser,
        or(eq(actorUser.auditPseudonym, auditLog.actorId), eq(actorUser.id, auditLog.actorId))
      )
      .leftJoin(resourceAgent, sql`${auditLog.resource} = 'agent:' || ${resourceAgent.id}`)
      .leftJoin(resourceUser, sql`${auditLog.resource} = 'user:' || ${resourceUser.id}`)
  );
}

/** One row as `auditSelectWithJoins()` returns it (projection + joined names). */
export type AuditJoinedRow = Awaited<ReturnType<typeof auditSelectWithJoins>>[number];

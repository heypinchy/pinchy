import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { auditLog, users, agents } from "@/db/schema";
import { desc, eq, and, gte, lte, count, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
  const eventType = url.searchParams.get("eventType");
  const actorId = url.searchParams.get("actorId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const conditions = [];
  if (eventType) conditions.push(eq(auditLog.eventType, eventType));
  if (actorId) conditions.push(eq(auditLog.actorId, actorId));
  if (from) conditions.push(gte(auditLog.timestamp, new Date(from)));
  if (to) {
    const toDate = new Date(to);
    if (!to.includes("T") && !to.includes(" ")) toDate.setUTCHours(23, 59, 59, 999);
    conditions.push(lte(auditLog.timestamp, toDate));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const actorUser = alias(users, "actor_user");
  const resourceAgent = alias(agents, "resource_agent");
  const resourceUser = alias(users, "resource_user");

  const [entries, totalResult] = await Promise.all([
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
        actorName: actorUser.name,
        actorDeleted: actorUser.deletedAt,
        resourceAgentName: resourceAgent.name,
        resourceAgentDeleted: resourceAgent.deletedAt,
        resourceUserName: resourceUser.name,
        resourceUserDeleted: resourceUser.deletedAt,
      })
      .from(auditLog)
      .leftJoin(actorUser, eq(actorUser.id, auditLog.actorId))
      .leftJoin(resourceAgent, sql`${auditLog.resource} = 'agent:' || ${resourceAgent.id}`)
      .leftJoin(resourceUser, sql`${auditLog.resource} = 'user:' || ${resourceUser.id}`)
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
    actorName: e.actorName ?? null,
    actorDeleted: !!e.actorDeleted,
    eventType: e.eventType,
    resource: e.resource,
    resourceName: e.resourceAgentName ?? e.resourceUserName ?? null,
    resourceDeleted: !!(e.resourceAgentDeleted ?? e.resourceUserDeleted ?? false),
    detail: e.detail,
    rowHmac: e.rowHmac,
  }));

  return NextResponse.json({
    entries: processedEntries,
    total: totalResult[0]?.count ?? 0,
    page,
    limit,
  });
}

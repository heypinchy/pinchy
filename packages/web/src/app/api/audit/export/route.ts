import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { auditLog, users, agents } from "@/db/schema";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { sanitizeDetail } from "@/lib/audit-sanitize";
import { renderAuditPdf, type AuditExportRow } from "@/lib/audit-pdf";

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "pdf") {
    return NextResponse.json(
      { error: `Unsupported format '${format}'. Use 'csv' or 'pdf'.` },
      { status: 400 }
    );
  }

  const eventType = url.searchParams.get("eventType");
  const actorId = url.searchParams.get("actorId");
  const resource = url.searchParams.get("resource");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const status = url.searchParams.get("status");

  const conditions = [];
  if (eventType) conditions.push(eq(auditLog.eventType, eventType));
  if (actorId) conditions.push(eq(auditLog.actorId, actorId));
  if (resource) conditions.push(eq(auditLog.resource, resource));
  if (status === "success" || status === "failure") {
    conditions.push(eq(auditLog.outcome, status));
  }
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

  const entries = await db
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
    .leftJoin(actorUser, eq(actorUser.id, auditLog.actorId))
    .leftJoin(resourceAgent, sql`${auditLog.resource} = 'agent:' || ${resourceAgent.id}`)
    .leftJoin(resourceUser, sql`${auditLog.resource} = 'user:' || ${resourceUser.id}`)
    .where(where)
    .orderBy(desc(auditLog.timestamp));

  const rows: AuditExportRow[] = entries.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    actorType: e.actorType,
    actorId: e.actorId,
    actorName: e.actorName ?? null,
    eventType: e.eventType,
    resource: e.resource,
    resourceName: e.resourceAgentName ?? e.resourceUserName ?? null,
    detail: e.detail ? sanitizeDetail(e.detail) : null,
    version: e.version,
    outcome: e.outcome === "success" || e.outcome === "failure" ? e.outcome : null,
    error: e.error as { message: string } | null,
    rowHmac: e.rowHmac,
  }));

  const datestamp = new Date().toISOString().slice(0, 10);

  if (format === "pdf") {
    const pdfBuffer = await renderAuditPdf(rows, {
      filters: { eventType, actorId, resource, from, to, status },
    });
    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="audit-log-${datestamp}.pdf"`,
      },
    });
  }

  // CSV
  const header =
    "id,timestamp,actorType,actorId,actorName,eventType,resource,resourceName,detail,version,outcome,error,rowHmac";

  const csvRows = rows.map((r) => {
    const detail = r.detail ? csvField(JSON.stringify(r.detail)) : '""';
    const error = r.error ? csvField(JSON.stringify(r.error)) : '""';
    const actorName = r.actorName ? csvField(r.actorName) : "";
    const resourceName = r.resourceName ? csvField(r.resourceName) : "";
    const outcome = r.outcome ?? "";
    return [
      r.id,
      r.timestamp.toISOString(),
      r.actorType,
      r.actorId,
      actorName,
      r.eventType,
      r.resource ?? "",
      resourceName,
      detail,
      r.version,
      outcome,
      error,
      r.rowHmac,
    ].join(",");
  });

  const csv = [header, ...csvRows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="audit-log-${datestamp}.csv"`,
    },
  });
}

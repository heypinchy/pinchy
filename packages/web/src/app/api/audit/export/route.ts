import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { auditLog, users, agents } from "@/db/schema";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { sanitizeDetail } from "@/lib/audit-sanitize";
import { appendAuditLog } from "@/lib/audit";
import { renderAuditPdf, buildFilterSummary, type AuditExportRow } from "@/lib/audit-pdf";

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isErrorObject(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

function exportTimestamp(now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}${min}`;
}

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const adminId = sessionOrError.user.id;

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "pdf") {
    return NextResponse.json(
      { error: `Unsupported format '${format}'. Use 'csv' or 'pdf'.` },
      { status: 400 }
    );
  }

  // Treat empty-string `status=` the same as an absent param — common
  // when forms serialize unset selects as `?status=`. Strict-validate
  // any other unknown value, mirroring the `format=` validation above.
  const statusRaw = url.searchParams.get("status");
  const status = statusRaw === "" ? null : statusRaw;
  if (status !== null && status !== "success" && status !== "failure") {
    return NextResponse.json(
      { error: `Unsupported status '${status}'. Use 'success' or 'failure'.` },
      { status: 400 }
    );
  }

  const eventType = url.searchParams.get("eventType");
  const actorId = url.searchParams.get("actorId");
  const resource = url.searchParams.get("resource");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

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
    // sanitizeDetail walks the object: it leaves the `message` key intact
    // but redacts known secret patterns inside the string itself. The
    // type guard is defense-in-depth — every row schema-validated to
    // {message: string} | null today, but a future migration or manual
    // backfill could violate that without TypeScript catching it.
    error: isErrorObject(e.error) ? sanitizeDetail(e.error) : null,
    rowHmac: e.rowHmac,
  }));

  const filters = { eventType, actorId, resource, from, to, status };
  const filterSummary = buildFilterSummary(filters);
  const filenameStem = `audit-log-${exportTimestamp(new Date())}`;

  let response: Response;
  if (format === "pdf") {
    const pdfBuffer = await renderAuditPdf(rows, { filters });
    response = new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filenameStem}.pdf"`,
      },
    });
  } else {
    const header =
      "id,timestamp,actorType,actorId,actorName,eventType,resource,resourceName,detail,version,outcome,error,rowHmac";

    const csvRows = rows.map((r) => {
      const detail = r.detail ? csvField(JSON.stringify(r.detail)) : '""';
      const error = r.error ? csvField(JSON.stringify(r.error)) : '""';
      const actorName = r.actorName ? csvField(r.actorName) : '""';
      const resourceName = r.resourceName ? csvField(r.resourceName) : '""';
      const outcome = r.outcome ? csvField(r.outcome) : '""';
      return [
        r.id,
        csvField(r.timestamp.toISOString()),
        csvField(r.actorType),
        csvField(r.actorId),
        actorName,
        csvField(r.eventType),
        csvField(r.resource ?? ""),
        resourceName,
        detail,
        r.version,
        outcome,
        error,
        csvField(r.rowHmac),
      ].join(",");
    });

    const csv = [header, ...csvRows].join("\n");

    response = new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${filenameStem}.csv"`,
      },
    });
  }

  // Audit the export itself (compliance requirement: who exported what, when).
  // Wrapped in try/catch so audit-log infrastructure failures don't break
  // exports — but logged loudly so a sustained outage of the audit-log
  // path is operationally visible. Sequential await (not fire-and-forget)
  // is intentional: an admin who clicks "Export" then immediately queries
  // the audit log expects to see their own entry, and the latency cost
  // of one INSERT is negligible compared to the export itself.
  try {
    await appendAuditLog({
      actorType: "user",
      actorId: adminId,
      eventType: "audit.exported",
      resource: null,
      outcome: "success",
      detail: { format, filterSummary, rowCount: rows.length },
    });
  } catch (err) {
    console.error("[audit-export] failed to log audit.exported event", err);
  }

  return response;
}

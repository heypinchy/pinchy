import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { desc, and } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { sanitizeDetail } from "@/lib/audit-sanitize";
import { appendAuditLog } from "@/lib/audit";
import { apiKeyActorName } from "@/lib/api-key-identity";
import { csvField } from "@/lib/csv";
import { renderAuditPdf, buildFilterSummary, type AuditExportRow } from "@/lib/audit-pdf";
import { buildAuditFilters, auditSelectWithJoins, MAX_AUDIT_EXPORT_ROWS } from "@/lib/audit-query";

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

  const filtersResult = await buildAuditFilters(url.searchParams, {
    includeResource: true,
    strictStatus: true,
  });
  if (!filtersResult.ok) return filtersResult.response;
  const { conditions, filters } = filtersResult;

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Fetch one row past the cap: cheaper than a second COUNT(*) query, and all
  // we need is "did more rows match than we're willing to export" (see
  // MAX_AUDIT_EXPORT_ROWS in lib/audit-query.ts).
  const entries = await auditSelectWithJoins()
    .where(where)
    .orderBy(desc(auditLog.timestamp))
    .limit(MAX_AUDIT_EXPORT_ROWS + 1);

  const truncated = entries.length > MAX_AUDIT_EXPORT_ROWS;
  const cappedEntries = truncated ? entries.slice(0, MAX_AUDIT_EXPORT_ROWS) : entries;

  const rows: AuditExportRow[] = cappedEntries.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    actorType: e.actorType,
    actorId: e.actorId,
    // Same api_key fallback as /api/audit — and it matters more here: this is
    // the artifact that gets handed to an auditor, so a bare key id in the
    // Actor column is a question Pinchy has to answer by hand later.
    actorName: e.actorName ?? apiKeyActorName(e.actorType, e.detail),
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

  const filterSummary = buildFilterSummary(filters);
  const filenameStem = `audit-log-${exportTimestamp(new Date())}`;

  // Signals a caller/script can read without parsing the body: a truncated
  // export is still a valid, complete-looking CSV/PDF otherwise, so silence
  // here would read as "this is the whole audit trail" when it isn't.
  const truncationHeaders: Record<string, string> = truncated
    ? { "X-Audit-Export-Truncated": "true" }
    : {};

  let response: Response;
  if (format === "pdf") {
    const pdfBuffer = await renderAuditPdf(rows, { filters, truncated });
    response = new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filenameStem}.pdf"`,
        ...truncationHeaders,
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

    // Trailing note (not a data row — it has a single field, so a strict
    // RFC 4180 reader sees a short final row rather than 13 empty columns).
    // Mirrors the `X-Audit-Export-Truncated` header for spreadsheet users who
    // never look at response headers.
    const truncationNote = truncated
      ? `\n${csvField(
          `Export truncated at ${MAX_AUDIT_EXPORT_ROWS} rows. Narrow the filters ` +
            `(date range, event type, actor) and export again to see the rest.`
        )}`
      : "";

    const csv = [header, ...csvRows].join("\n") + truncationNote;

    response = new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${filenameStem}.csv"`,
        ...truncationHeaders,
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
      detail: { format, filterSummary, rowCount: rows.length, truncated },
    });
  } catch (err) {
    console.error("[audit-export] failed to log audit.exported event", err);
  }

  return response;
}

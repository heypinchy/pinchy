import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { desc, and } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { sanitizeDetail } from "@/lib/audit-sanitize";
import { appendAuditLog } from "@/lib/audit";
import { apiKeyActorName } from "@/lib/api-key-identity";
import { csvField } from "@/lib/csv";
import { renderAuditPdf, buildFilterSummary, type AuditExportRow } from "@/lib/audit-pdf";
import {
  buildAuditFilters,
  auditSelectWithJoins,
  MAX_AUDIT_EXPORT_ROWS,
  type AuditJoinedRow,
} from "@/lib/audit-query";

// Rows per streamed chunk. Small enough that no single chunk is a large
// allocation (~0.5 MB at the 2048-byte `detail` budget), large enough that
// 100k rows do not cost 100k `pull()` round trips.
const CSV_STREAM_BATCH_ROWS = 250;

function isErrorObject(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/** One joined `audit_log` row → the shape both output formats consume. */
function toExportRow(e: AuditJoinedRow): AuditExportRow {
  return {
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
  };
}

const CSV_HEADER =
  "id,timestamp,actorType,actorId,actorName,eventType,resource,resourceName,detail,version,outcome,error,rowHmac";

function csvLine(r: AuditExportRow): string {
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
  const rowCount = cappedEntries.length;

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
    const rows: AuditExportRow[] = cappedEntries.map(toExportRow);
    const pdfBuffer = await renderAuditPdf(rows, { filters, truncated });
    response = new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filenameStem}.pdf"`,
        ...truncationHeaders,
      },
    });
  } else {
    // Trailing note carrying the same signal as `X-Audit-Export-Truncated`,
    // for the (common) case where the file is forwarded and nobody ever sees
    // the response headers. It is a single-field line, so a reader that
    // enforces RFC 4180 §2.4 (equal field counts) rejects it rather than
    // mistaking it for data — but a lenient reader (pandas, Excel) DOES
    // surface it as a final row with the text in the `id` column. That is the
    // deliberate trade: a visible oddity beats a file that silently claims to
    // be the whole audit trail.
    const truncationNote = truncated
      ? `\n${csvField(
          `Export truncated at ${MAX_AUDIT_EXPORT_ROWS} rows. Narrow the filters ` +
            `(date range, event type, actor) and export again to see the rest.`
        )}`
      : "";

    // Stream the CSV instead of assembling it in the heap. The row cap alone
    // does NOT bound memory. Measured against this route at the cap with
    // `detail` at its 2048-byte budget (AGENTS.md), 232 MB of CSV: building
    // `rows` + `csvRows` + the joined string and serializing the body peaked
    // at 1215 MB RSS — past the 1 GB container the cap exists to protect, so
    // the cap did not achieve its own goal. Emitting the rows in batches under
    // the reader's backpressure peaks at 576 MB, of which the already-fetched
    // `cappedEntries` is the bulk (bounding THAT needs a DB cursor, not a
    // smaller number here). Keep it lazy:
    // reintroducing a `.map()` over all rows, or a `.join()` of all lines,
    // restores the full peak — the "body is lazy" tests in
    // __tests__/api/audit-export.test.ts guard exactly that.
    //
    // The cost of streaming: a throw after the first chunk cannot become a 500,
    // because the 200 is already on the wire. It aborts the response body
    // instead, which a client sees as a broken transfer — not as a shorter but
    // valid audit file.
    const encoder = new TextEncoder();
    let cursor = 0;
    let headerSent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(CSV_HEADER));
          return;
        }
        if (cursor >= cappedEntries.length) {
          if (truncationNote) controller.enqueue(encoder.encode(truncationNote));
          controller.close();
          return;
        }
        const end = Math.min(cursor + CSV_STREAM_BATCH_ROWS, cappedEntries.length);
        let chunk = "";
        for (; cursor < end; cursor++) chunk += `\n${csvLine(toExportRow(cappedEntries[cursor]))}`;
        controller.enqueue(encoder.encode(chunk));
      },
    });

    response = new Response(stream, {
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
      detail: { format, filterSummary, rowCount, truncated },
    });
  } catch (err) {
    console.error("[audit-export] failed to log audit.exported event", err);
  }

  return response;
}

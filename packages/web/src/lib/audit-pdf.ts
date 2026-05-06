import PDFDocument from "pdfkit";

export type AuditExportRow = {
  id: number;
  timestamp: Date;
  actorType: string;
  actorId: string;
  actorName: string | null;
  eventType: string;
  resource: string | null;
  resourceName: string | null;
  detail: unknown;
  version: number;
  outcome: "success" | "failure" | null;
  error: { message: string } | null;
  rowHmac: string;
};

export type AuditPdfOptions = {
  filters?: {
    eventType?: string | null;
    actorId?: string | null;
    resource?: string | null;
    from?: string | null;
    to?: string | null;
    status?: string | null;
  };
};

export function formatActor(row: AuditExportRow): string {
  if (row.actorName) return row.actorName;
  return row.actorId.length > 8 ? `${row.actorId.slice(0, 8)}…` : row.actorId;
}

export function formatResource(row: AuditExportRow): string {
  if (row.resourceName) return row.resourceName;
  if (!row.resource) return "—";
  return row.resource.length > 30 ? `${row.resource.slice(0, 30)}…` : row.resource;
}

export function buildFilterSummary(filters: AuditPdfOptions["filters"]): string {
  if (!filters) return "All entries";
  const parts: string[] = [];
  if (filters.eventType) parts.push(`event=${filters.eventType}`);
  if (filters.actorId) parts.push(`actor=${filters.actorId}`);
  if (filters.resource) parts.push(`resource=${filters.resource}`);
  if (filters.status) parts.push(`status=${filters.status}`);
  if (filters.from) parts.push(`from=${filters.from.slice(0, 10)}`);
  if (filters.to) parts.push(`to=${filters.to.slice(0, 10)}`);
  return parts.length === 0 ? "All entries" : parts.join(", ");
}

export function renderAuditPdf(
  rows: AuditExportRow[],
  options: AuditPdfOptions = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: {
        Title: "Pinchy Audit Trail Report",
        Author: "Pinchy",
        Subject: "Audit log export",
        CreationDate: new Date(),
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header ─────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(18).text("Pinchy Audit Trail Report", { align: "left" });
    doc.moveDown(0.2);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#555")
      .text(`Generated: ${new Date().toISOString()}`)
      .text(`Filters: ${buildFilterSummary(options.filters)}`)
      .text(`Total entries: ${rows.length}`)
      .fillColor("black");
    doc.moveDown(0.5);

    // ── Table ──────────────────────────────────────────────────────────
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { label: "Timestamp (UTC)", width: 120 },
      { label: "Actor", width: 90 },
      { label: "Event", width: 110 },
      { label: "Resource", width: 110 },
      { label: "Status", width: 50 },
      { label: "Hash", width: pageWidth - 120 - 90 - 110 - 110 - 50 },
    ];

    const drawHeader = () => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(9);
      let x = doc.page.margins.left;
      for (const col of cols) {
        doc.text(col.label, x, y, { width: col.width, lineBreak: false });
        x += col.width;
      }
      doc
        .moveTo(doc.page.margins.left, y + 14)
        .lineTo(doc.page.margins.left + pageWidth, y + 14)
        .strokeColor("#888")
        .stroke();
      doc.y = y + 18;
      doc.font("Helvetica").fontSize(8);
    };

    drawHeader();

    if (rows.length === 0) {
      doc
        .fontSize(10)
        .fillColor("#666")
        .text("No audit entries match the selected filters.", { align: "center" });
      doc.fillColor("black");
    } else {
      for (const row of rows) {
        // Page break check (leave room for footer)
        if (doc.y > doc.page.height - doc.page.margins.bottom - 60) {
          doc.addPage();
          drawHeader();
        }

        const y = doc.y;
        const statusColor =
          row.outcome === "success" ? "#0a7a2f" : row.outcome === "failure" ? "#b40020" : "#666";
        const cells: { text: string; color?: string }[] = [
          { text: row.timestamp.toISOString().replace("T", " ").slice(0, 19) },
          { text: formatActor(row) },
          { text: row.eventType },
          { text: formatResource(row) },
          { text: row.outcome ?? "—", color: statusColor },
          { text: row.rowHmac.slice(0, 16) },
        ];

        let x = doc.page.margins.left;
        let maxRowHeight = 0;
        for (const [idx, cell] of cells.entries()) {
          const col = cols.at(idx)!;
          doc.fillColor(cell.color ?? "black");
          doc.text(cell.text, x, y, { width: col.width });
          maxRowHeight = Math.max(maxRowHeight, doc.y - y);
          x += col.width;
        }
        doc.fillColor("black");
        doc.y = y + maxRowHeight + 2;

        // Show error message in muted red below the row
        if (row.outcome === "failure" && row.error?.message) {
          if (doc.y > doc.page.height - doc.page.margins.bottom - 60) {
            doc.addPage();
            drawHeader();
          }
          doc
            .fontSize(8)
            .fillColor("#b40020")
            .text(`Error: ${row.error.message}`, doc.page.margins.left + 10, doc.y, {
              width: pageWidth - 20,
            })
            .fillColor("black")
            .fontSize(8);
          doc.moveDown(0.2);
        }
      }
    }

    // ── Footer with page numbers ───────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const bottom = doc.page.height - doc.page.margins.bottom + 10;
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#666")
        .text(
          `Pinchy Audit Trail • Page ${i + 1} of ${range.count} • HMAC-SHA256 signed`,
          doc.page.margins.left,
          bottom,
          {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            align: "center",
          }
        )
        .fillColor("black");
    }

    doc.end();
  });
}

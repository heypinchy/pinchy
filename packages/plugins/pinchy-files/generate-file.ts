import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export type GenerateFileFormat = "csv" | "xlsx" | "pdf";

export type CellValue = string | number | boolean | null;

export interface GenerateFileInput {
  format: GenerateFileFormat;
  columns: string[];
  rows: CellValue[][];
  title?: string;
}

export interface GenerateFileResult {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

const SUPPORTED_FORMATS: GenerateFileFormat[] = ["csv", "xlsx", "pdf"];

// Memory-blowup guard: an agent could otherwise hand us an unbounded row
// count and OOM the plugin process while buffering the rendered file.
const MAX_ROWS = 50_000;

function validateInput(input: GenerateFileInput): void {
  if (!SUPPORTED_FORMATS.includes(input.format)) {
    throw new Error(`Unsupported format: ${input.format as string}`);
  }
  if (!Array.isArray(input.columns) || input.columns.length === 0) {
    throw new Error("columns must be a non-empty array");
  }
  if (input.rows.length > MAX_ROWS) {
    throw new Error(`too many rows: ${input.rows.length} exceeds the limit of ${MAX_ROWS}`);
  }
  input.rows.forEach((row, i) => {
    if (row.length !== input.columns.length) {
      throw new Error(`row ${i + 1} has ${row.length} cells, expected ${input.columns.length}`);
    }
    for (const cell of row) {
      if (cell !== null && !["string", "number", "boolean"].includes(typeof cell)) {
        throw new Error("cell is not a string, number, boolean, or null");
      }
    }
  });
}

const CSV_BOM = "﻿";

// CSV/spreadsheet formula injection (CWE-1236): Excel, Google Sheets, and
// LibreOffice treat a cell beginning with any of these characters as a
// formula to evaluate. These generated files land on a real user's machine,
// so a string cell that starts with one is prefixed with a literal
// apostrophe, which every mainstream spreadsheet app renders as "force text"
// without displaying the apostrophe itself.
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function serializeCellToString(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value;
}

function csvField(value: CellValue): string {
  let raw = serializeCellToString(value);
  // Only string cells are at risk — numbers/booleans are serialized above
  // and must stay literal (e.g. a numeric -5 must render as -5, not '-5).
  if (typeof value === "string" && CSV_FORMULA_TRIGGER.test(raw)) {
    raw = `'${raw}`;
  }
  if (/["\r\n,]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function renderCsv(columns: string[], rows: CellValue[][]): Buffer {
  const lines = [columns.join(","), ...rows.map((row) => row.map(csvField).join(","))];
  return Buffer.from(CSV_BOM + lines.join("\r\n") + "\r\n", "utf-8");
}

function serializeCellForXlsx(value: CellValue): string | number | boolean {
  return value === null ? "" : value;
}

// Characters exceljs (and Excel itself) forbid in a worksheet name, plus the
// 31-character length cap. A user-supplied `title` is untrusted free text,
// so we sanitize it locally rather than let addWorksheet() throw and crash
// the whole render.
const XLSX_SHEET_NAME_FORBIDDEN = /[*?:\\/[\]]/g;
const XLSX_SHEET_NAME_MAX_LENGTH = 31;

function sanitizeSheetName(title: string | undefined): string {
  if (!title) return "Sheet1";
  const sanitized = title
    .replace(XLSX_SHEET_NAME_FORBIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, XLSX_SHEET_NAME_MAX_LENGTH)
    .trim();
  return sanitized || "Sheet1";
}

async function renderXlsx(
  columns: string[],
  rows: CellValue[][],
  title: string | undefined
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sanitizeSheetName(title));
  worksheet.addRow(columns);
  worksheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    worksheet.addRow(row.map(serializeCellForXlsx));
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function renderPdf(
  columns: string[],
  rows: CellValue[][],
  title: string | undefined
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (title) {
      doc.font("Helvetica-Bold").fontSize(16).text(title, { align: "left" });
      doc.moveDown(0.5);
    }

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = pageWidth / columns.length;

    // pdfkit's `text()` word-wraps within `width` regardless of `lineBreak`
    // (that option only skips auto-computing a *default* width when none is
    // passed — pdfkit@0.19.1's LineWrapper never reads `options.lineBreak`
    // once a width is given, verified against its source and empirically).
    // Worse, without an explicit `height`, a wrapped cell's `maxY` defaults
    // to the *page* bottom, so `ellipsis` never engages and pdfkit will
    // happily auto-paginate mid-cell for a long enough string. Bounding both
    // the header and every data cell to an explicit single-line `height`
    // (with `ellipsis: true`) is what actually keeps them single-line: it
    // makes truncation the hard stop instead of the page boundary.
    doc.font("Helvetica-Bold").fontSize(10);
    const HEADER_LINE_HEIGHT = doc.currentLineHeight(true);
    doc.font("Helvetica").fontSize(9);
    const ROW_LINE_HEIGHT = doc.currentLineHeight(true);

    const drawHeader = () => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10);
      let x = doc.page.margins.left;
      for (const col of columns) {
        doc.text(col, x, y, { width: colWidth, height: HEADER_LINE_HEIGHT, ellipsis: true });
        x += colWidth;
      }
      doc
        .moveTo(doc.page.margins.left, y + 14)
        .lineTo(doc.page.margins.left + pageWidth, y + 14)
        .strokeColor("#888")
        .stroke();
      doc.y = y + 18;
      doc.font("Helvetica").fontSize(9);
    };

    drawHeader();

    for (const row of rows) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      let x = doc.page.margins.left;
      for (const cell of row) {
        doc.text(serializeCellToString(cell), x, y, {
          width: colWidth,
          height: ROW_LINE_HEIGHT,
          ellipsis: true,
        });
        x += colWidth;
      }
      doc.y = y + ROW_LINE_HEIGHT + 2;
    }

    doc.end();
  });
}

export async function generateFile(input: GenerateFileInput): Promise<GenerateFileResult> {
  validateInput(input);
  switch (input.format) {
    case "csv":
      return {
        buffer: renderCsv(input.columns, input.rows),
        mimeType: "text/csv",
        ext: "csv",
      };
    case "xlsx":
      return {
        buffer: await renderXlsx(input.columns, input.rows, input.title),
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ext: "xlsx",
      };
    case "pdf":
      return {
        buffer: await renderPdf(input.columns, input.rows, input.title),
        mimeType: "application/pdf",
        ext: "pdf",
      };
    default:
      throw new Error(`Unsupported format: ${input.format as string}`);
  }
}

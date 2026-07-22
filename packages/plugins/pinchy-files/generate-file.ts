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

function serializeCell(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value;
}

function csvField(value: CellValue): string {
  const raw = serializeCell(value);
  if (/["\r\n,]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function renderCsv(columns: string[], rows: CellValue[][]): Buffer {
  const lines = [columns.join(","), ...rows.map((row) => row.map(csvField).join(","))];
  return Buffer.from(CSV_BOM + lines.join("\r\n") + "\r\n", "utf-8");
}

function serializeXlsxCell(value: CellValue): string | number | boolean {
  return value === null ? "" : value;
}

async function renderXlsx(
  columns: string[],
  rows: CellValue[][],
  title: string | undefined
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(title || "Sheet1");
  worksheet.addRow(columns);
  worksheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    worksheet.addRow(row.map(serializeXlsxCell));
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

    const drawHeader = () => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10);
      let x = doc.page.margins.left;
      for (const col of columns) {
        doc.text(col, x, y, { width: colWidth, ellipsis: true });
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
      let maxRowHeight = 0;
      for (const cell of row) {
        doc.text(serializeCell(cell), x, y, { width: colWidth, ellipsis: true });
        maxRowHeight = Math.max(maxRowHeight, doc.y - y);
        x += colWidth;
      }
      doc.y = y + maxRowHeight;
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

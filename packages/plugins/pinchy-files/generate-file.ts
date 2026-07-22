import ExcelJS from "exceljs";

export type GenerateFileFormat = "csv" | "xlsx";

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

export async function generateFile(input: GenerateFileInput): Promise<GenerateFileResult> {
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
    default:
      throw new Error(`Unsupported format: ${input.format as string}`);
  }
}

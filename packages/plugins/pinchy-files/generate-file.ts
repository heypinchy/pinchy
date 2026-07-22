export type GenerateFileFormat = "csv";

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

export function generateFile(input: GenerateFileInput): GenerateFileResult {
  switch (input.format) {
    case "csv":
      return {
        buffer: renderCsv(input.columns, input.rows),
        mimeType: "text/csv",
        ext: "csv",
      };
    default:
      throw new Error(`Unsupported format: ${input.format as string}`);
  }
}

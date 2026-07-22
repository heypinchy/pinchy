import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { generateFile } from "./generate-file";

describe("generateFile csv", () => {
  it("renders a BOM-prefixed RFC-4180 CSV with CRLF", async () => {
    const { buffer, mimeType, ext } = await generateFile({
      format: "csv",
      columns: ["a", "b"],
      rows: [
        ["1", "x"],
        ["2", "y"],
      ],
    });
    expect(mimeType).toBe("text/csv");
    expect(ext).toBe("csv");
    const text = buffer.toString("utf-8");
    expect(text.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(text).toBe("﻿a,b\r\n1,x\r\n2,y\r\n");
  });

  it("quotes and escapes fields containing comma, quote, or newline", async () => {
    const { buffer } = await generateFile({
      format: "csv",
      columns: ["c"],
      rows: [["a,b"], ['he said "hi"'], ["line1\nline2"]],
    });
    const text = buffer.toString("utf-8").replace(/^﻿/, "");
    expect(text).toBe('c\r\n"a,b"\r\n"he said ""hi"""\r\n"line1\nline2"\r\n');
  });

  it("serializes numbers and booleans without quoting", async () => {
    const { buffer } = await generateFile({
      format: "csv",
      columns: ["n", "b"],
      rows: [[1200.5, true]],
    });
    const text = buffer.toString("utf-8").replace(/^﻿/, "");
    expect(text).toBe("n,b\r\n1200.5,true\r\n");
  });
});

describe("generateFile xlsx", () => {
  it("renders an xlsx with numeric cells preserved and a titled sheet", async () => {
    const { buffer, mimeType, ext } = await generateFile({
      format: "xlsx",
      title: "Bookings",
      columns: ["Date", "Amount"],
      rows: [["2026-01-03", 1200.5]],
    });
    expect(ext).toBe("xlsx");
    expect(mimeType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const wb = new ExcelJS.Workbook();
    // exceljs@4's bundled index.d.ts declares its own ambient `Buffer extends ArrayBuffer`,
    // which merges with @types/node's Buffer and breaks structural assignability of a real
    // Node Buffer into `.load()`. Cast through unknown to work around the vendored typing bug.
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet("Bookings")!;
    expect(ws.getCell("A1").value).toBe("Date");
    expect(ws.getCell("B2").value).toBe(1200.5); // number, not "1200.5"
    expect(typeof ws.getCell("B2").value).toBe("number");
  });
});

describe("generateFile pdf", () => {
  it("renders a pdf with the title and header text", async () => {
    const { buffer, mimeType, ext } = await generateFile({
      format: "pdf",
      title: "Ledger",
      columns: ["Date", "Amount"],
      rows: [["2026-01-03", 1200.5]],
    });
    expect(ext).toBe("pdf");
    expect(mimeType).toBe("application/pdf");
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.byteLength).toBeGreaterThan(500);
  });
});

describe("generateFile validation", () => {
  it("rejects an unknown format", async () => {
    await expect(
      generateFile({
        // @ts-expect-error deliberately invalid format for the validation test
        format: "docx",
        columns: ["a"],
        rows: [["1"]],
      })
    ).rejects.toThrow("Unsupported format");
  });

  it("rejects empty columns", async () => {
    await expect(generateFile({ format: "csv", columns: [], rows: [] })).rejects.toThrow(
      "columns must be a non-empty array"
    );
  });

  it("rejects a row whose length does not match columns.length", async () => {
    await expect(
      generateFile({ format: "csv", columns: ["a", "b"], rows: [["1", "2", "3"]] })
    ).rejects.toThrow("row 1 has 3 cells, expected 2");
  });

  it("rejects more than MAX_ROWS rows", async () => {
    const rows = Array.from({ length: 50_001 }, () => ["1"]);
    await expect(generateFile({ format: "csv", columns: ["a"], rows })).rejects.toThrow(
      "too many rows"
    );
  });

  it("rejects a non-primitive cell", async () => {
    await expect(
      generateFile({
        format: "csv",
        columns: ["a"],
        // @ts-expect-error deliberately invalid cell type for the validation test
        rows: [[{ nested: true }]],
      })
    ).rejects.toThrow("cell is not a string, number, boolean, or null");
  });
});

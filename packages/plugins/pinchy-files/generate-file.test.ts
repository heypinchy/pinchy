import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { generateFile } from "./generate-file";

/** Page count of a rendered PDF, used to detect pdfkit auto-pagination caused
 * by an unbounded wrap (the regression #1/#2 guard against). No font data or
 * canvas factory is needed just to read structural page count. */
async function countPdfPages(buffer: Buffer): Promise<number> {
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableAutoFetch: true,
    disableFontFace: true,
    useSystemFonts: false,
  } as Record<string, unknown>).promise;
  const numPages = doc.numPages;
  await doc.destroy();
  return numPages;
}

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

  it("prefixes a leading apostrophe on a string cell that looks like a spreadsheet formula", async () => {
    const { buffer } = await generateFile({
      format: "csv",
      columns: ["c"],
      rows: [["=SUM(A1)"]],
    });
    const text = buffer.toString("utf-8").replace(/^﻿/, "");
    expect(text).toBe("c\r\n'=SUM(A1)\r\n");
  });

  it("prefixes every CSV/spreadsheet formula-injection trigger character (+, -, @, tab, CR)", async () => {
    const { buffer } = await generateFile({
      format: "csv",
      columns: ["c"],
      rows: [["+1"], ["-1"], ["@cmd"], ["\tx"], ["\ry"]],
    });
    const text = buffer.toString("utf-8").replace(/^﻿/, "");
    // Only \r (a CSV quote-trigger char) additionally gets RFC-4180 quoted;
    // the apostrophe prefix itself never contains a quote/comma/newline.
    const expectedLines = ["c", "'+1", "'-1", "'@cmd", "'\tx", '"\'\ry"'];
    expect(text).toBe(expectedLines.join("\r\n") + "\r\n");
  });

  it("does not prefix a numeric cell even if it renders with a leading minus sign", async () => {
    const { buffer } = await generateFile({
      format: "csv",
      columns: ["n"],
      rows: [[-5]],
    });
    const text = buffer.toString("utf-8").replace(/^﻿/, "");
    expect(text).toBe("n\r\n-5\r\n");
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

  it("sanitizes forbidden characters and length from the xlsx sheet name instead of crashing", async () => {
    const { buffer } = await generateFile({
      format: "xlsx",
      title: "Q1/Q2 Comparison",
      columns: ["a"],
      rows: [["1"]],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets).toHaveLength(1);
    const sheetName = wb.worksheets[0].name;
    expect(sheetName).not.toMatch(/[*?:\\/[\]]/);
    expect(sheetName).toBe("Q1 Q2 Comparison");
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

  it("keeps a very long header label on a single line instead of overlapping the rule/first row", async () => {
    // pdfkit auto-paginates ("continueOnNewPage") when a wrapped text() call
    // has no explicit height and runs past the page bottom. A header column
    // this long, left unbounded, wraps for pages purely from ONE cell — a
    // reliable structural signal (independent of pixel positions) that the
    // header escaped its single-line band. Bounded (fixed), it always stays 1.
    const longHeader = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const { buffer } = await generateFile({
      format: "pdf",
      columns: ["Id", longHeader, "C"],
      rows: [],
    });
    expect(await countPdfPages(buffer)).toBe(1);
  });

  it("keeps a data row bounded to a single line instead of growing arbitrarily tall for long free text", async () => {
    // Same auto-pagination signal as above, applied to a data cell: an
    // unbounded long cell forces pdfkit to insert pages by itself even
    // though only 3 short rows are being rendered.
    const longCell = Array.from({ length: 800 }, (_, i) => `word${i}`).join(" ");
    const { buffer } = await generateFile({
      format: "pdf",
      columns: ["Id", "Note"],
      rows: [
        ["1", "short"],
        ["2", longCell],
        ["3", "short"],
      ],
    });
    expect(await countPdfPages(buffer)).toBe(1);
  });

  it("renders a wide multi-column table with a long header and long cell text across a forced page break (layout smoke test)", async () => {
    // We can't easily assert pixel-level layout from pdfkit's output. This
    // exercises the header-wrap-bound and cell-height-bound code paths (a
    // long header label, a long free-text cell, and enough rows to force a
    // real page break) without crashing, and confirms multi-page pagination
    // still works once rows are legitimately too many for one page — i.e.
    // that bounding cell height didn't also disable normal pagination.
    const longHeader = "A Very Long Column Header That Would Otherwise Wrap Across Several Lines";
    const longCell =
      "A long free-text cell value that would otherwise grow the row height arbitrarily tall and bleed past the printable page area if not bounded.";
    const columns = ["Id", longHeader, "C", "D", "E", "F"];
    const rows = Array.from({ length: 80 }, (_, i) => [
      String(i + 1),
      i === 0 ? longCell : "x",
      "y",
      "z",
      "w",
      "v",
    ]);
    const { buffer, ext, mimeType } = await generateFile({
      format: "pdf",
      title: "Wide Report",
      columns,
      rows,
    });
    expect(ext).toBe("pdf");
    expect(mimeType).toBe("application/pdf");
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.byteLength).toBeGreaterThan(500);
    expect(await countPdfPages(buffer)).toBeGreaterThan(1);
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

  it("rejects a row that is not an array", async () => {
    // A 2-char string against 2 columns has a matching .length, so the
    // length check alone wouldn't catch it — it would instead blow up later
    // with an opaque "row.map is not a function" once rendering starts.
    await expect(
      generateFile({
        format: "csv",
        columns: ["a", "b"],
        // @ts-expect-error deliberately invalid row type for the validation test
        rows: ["ab"],
      })
    ).rejects.toThrow("row 1 is not an array");
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

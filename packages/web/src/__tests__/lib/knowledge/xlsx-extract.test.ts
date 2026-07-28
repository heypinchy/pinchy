/**
 * extractXlsx against real workbooks written on the fly with exceljs (the same
 * library the extractor reads with, and already a web dependency), so this is a
 * true round-trip without a checked-in binary fixture — same approach as
 * pdf-extract.test.ts.
 *
 * The two real corpus files named in the issue are NOT committed: they are a
 * customer's 3M vendor data, and this repository is public. They are exercised
 * by the opt-in block at the bottom, pointed at a local corpus via
 * KB_XLSX_CORPUS_DIR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";

import { extractXlsx, XlsxExtractionError } from "@/lib/knowledge/xlsx-extract";

/** The first 8 bytes of every legacy BIFF .xls: the OLE2 compound-file magic. */
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-xlsx-extract-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Writes a workbook built by `build` into the test tmp dir and returns its path. */
async function buildWorkbook(
  name: string,
  build: (workbook: ExcelJS.Workbook) => void
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const path = join(tmpRoot, name);
  await workbook.xlsx.writeFile(path);
  return path;
}

/** Every row line of a chunk (i.e. everything below the `Sheet: …` preamble). */
function rowLines(text: string): string[] {
  return text.split("\n").slice(1);
}

describe("sheets and row anchors", () => {
  it("extracts rows with their sheet name and Excel row numbers", async () => {
    const path = await buildWorkbook("multi-sheet.xlsx", (workbook) => {
      const products = workbook.addWorksheet("Products");
      products.addRow(["Article", "Description"]);
      products.addRow(["A-1", "Petrifilm plate"]);
      products.addRow(["A-2", "Aqua plate"]);

      const storage = workbook.addWorksheet("Storage");
      storage.addRow(["Article", "Condition"]);
      storage.addRow(["A-1", "2-8 degrees C"]);
    });

    const { chunks, sheets } = await extractXlsx(path);

    expect(sheets).toEqual(["Products", "Storage"]);
    expect(chunks).toEqual([
      {
        sheet: "Products",
        startRow: 2,
        endRow: 3,
        text: "Sheet: Products\nArticle: A-1; Description: Petrifilm plate\nArticle: A-2; Description: Aqua plate",
      },
      {
        sheet: "Storage",
        startRow: 2,
        endRow: 2,
        text: "Sheet: Storage\nArticle: A-1; Condition: 2-8 degrees C",
      },
    ]);
  });

  it("never puts two sheets in one chunk, even when both would fit the budget", async () => {
    const path = await buildWorkbook("tiny-sheets.xlsx", (workbook) => {
      for (const name of ["One", "Two", "Three"]) {
        const sheet = workbook.addWorksheet(name);
        sheet.addRow(["Key"]);
        sheet.addRow([`value for ${name}`]);
      }
    });

    const { chunks } = await extractXlsx(path);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.sheet)).toEqual(["One", "Two", "Three"]);
  });

  it("keeps Excel's own row numbers across skipped rows", async () => {
    const path = await buildWorkbook("gaps.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Gaps");
      sheet.addRow(["Key", "Value"]);
      sheet.addRow(["first", 1]);
      sheet.addRow([]);
      sheet.addRow([]);
      sheet.addRow(["last", 2]);
    });

    const { chunks } = await extractXlsx(path);

    // Rows 3 and 4 are blank and drop out, but row 5 stays row 5 — the anchor
    // has to match what the reader sees in Excel's row gutter, not a
    // re-numbering of the rows we happened to keep.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startRow: 2, endRow: 5 });
    expect(rowLines(chunks[0].text)).toEqual(["Key: first; Value: 1", "Key: last; Value: 2"]);
  });

  it("falls back to column letters when the sheet has no header row", async () => {
    const path = await buildWorkbook("no-header.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Raw");
      // First row already carries data (a number), so it is not a header.
      sheet.addRow([1, "first"]);
      sheet.addRow([2, "second"]);
    });

    const { chunks } = await extractXlsx(path);

    expect(rowLines(chunks[0].text)).toEqual(["A: 1; B: first", "A: 2; B: second"]);
    expect(chunks[0].startRow).toBe(1);
  });
});

describe("cell values", () => {
  it("uses a formula's cached result, never the formula text", async () => {
    const path = await buildWorkbook("formulas.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Calc");
      sheet.addRow(["Item", "Qty", "Total"]);
      sheet.addRow(["Hammer", 2, { formula: "B2*10", result: 20 }]);
    });

    const { chunks } = await extractXlsx(path);

    expect(rowLines(chunks[0].text)).toEqual(["Item: Hammer; Qty: 2; Total: 20"]);
    expect(chunks[0].text).not.toContain("B2*10");
  });

  it("drops a formula cell that was never calculated instead of indexing its source", async () => {
    const path = await buildWorkbook("uncalculated.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Calc");
      sheet.addRow(["Item", "Total"]);
      const row = sheet.addRow(["Hammer", null]);
      row.getCell(2).value = { formula: "A1" } as ExcelJS.CellFormulaValue;
    });

    const { chunks } = await extractXlsx(path);

    expect(rowLines(chunks[0].text)).toEqual(["Item: Hammer"]);
  });

  it("carries a merged cell's value into every row it spans", async () => {
    const path = await buildWorkbook("merged.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Catalog");
      sheet.addRow(["Category", "Product"]);
      sheet.addRow(["Petrifilm Rapid", "Coliform Count Plate"]);
      sheet.addRow([null, "E. coli Count Plate"]);
      sheet.mergeCells("A2:A3");
    });

    const { chunks } = await extractXlsx(path);

    // The category lives in the merged master cell only. A row-shaped chunk
    // has to stand on its own, so the second row must still say which
    // category it belongs to.
    expect(rowLines(chunks[0].text)).toEqual([
      "Category: Petrifilm Rapid; Product: Coliform Count Plate",
      "Category: Petrifilm Rapid; Product: E. coli Count Plate",
    ]);
  });

  it("flattens rich text, hyperlinks, dates and booleans into readable values", async () => {
    const path = await buildWorkbook("value-shapes.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Shapes");
      sheet.addRow(["Kind", "Value"]);
      const rich = sheet.addRow(["rich", null]);
      rich.getCell(2).value = { richText: [{ text: "Hello " }, { text: "world" }] };
      const link = sheet.addRow(["link", null]);
      link.getCell(2).value = { text: "Pinchy", hyperlink: "https://heypinchy.com" };
      sheet.addRow(["date", new Date(Date.UTC(2026, 0, 2))]);
      sheet.addRow(["bool", true]);
    });

    const { chunks } = await extractXlsx(path);

    expect(rowLines(chunks[0].text)).toEqual([
      "Kind: rich; Value: Hello world",
      "Kind: link; Value: Pinchy (https://heypinchy.com)",
      "Kind: date; Value: 2026-01-02",
      "Kind: bool; Value: true",
    ]);
  });

  it("reads a hyperlink whose label is rich text", async () => {
    const path = await buildWorkbook("rich-hyperlink.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Links");
      sheet.addRow(["Kind", "Value"]);
      sheet.addRow([
        "richlink",
        // exceljs types `text` as a string, but a hyperlink cell whose label
        // carries mixed formatting — the normal case for a styled link — reads
        // back with a richText OBJECT there. Its own typings do not model that.
        {
          text: { richText: [{ text: "Rich " }, { text: "link" }] },
          hyperlink: "https://example.com/rich",
        } as unknown as ExcelJS.CellHyperlinkValue,
      ]);
    });

    const { chunks } = await extractXlsx(path);

    expect(rowLines(chunks[0].text)).toEqual([
      "Kind: richlink; Value: Rich link (https://example.com/rich)",
    ]);
  });

  it("renders a percent-formatted cell the way the sheet displays it", async () => {
    const path = await buildWorkbook("percent.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Margins");
      sheet.addRow(["Product", "Margin", "Discount"]);
      const row = sheet.addRow(["A-1", 0.15, 0.075]);
      row.getCell(2).numFmt = "0%";
      row.getCell(3).numFmt = "0.0%;[Red]-0.0%";
    });

    const { chunks } = await extractXlsx(path);

    // Excel's `%` multiplies by 100 for display. Indexing the stored 0.15 would
    // make the document answer "15%" with "0.15" — a wrong number, not merely
    // an unformatted one, and exactly the failure the formula rule avoids.
    expect(rowLines(chunks[0].text)).toEqual(["Product: A-1; Margin: 15%; Discount: 7.5%"]);
  });

  it("does not scale a value whose format only contains a quoted percent sign", async () => {
    const path = await buildWorkbook("quoted-percent.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Literal");
      sheet.addRow(["Kind", "Value"]);
      const row = sheet.addRow(["literal", 0.15]);
      // A quoted % is a literal suffix in Excel's format language and carries
      // no multiplier — the cell reads 0.15%, so the value must stay 0.15.
      row.getCell(2).numFmt = '0.00"%"';
    });

    const { chunks } = await extractXlsx(path);

    expect(rowLines(chunks[0].text)).toEqual(["Kind: literal; Value: 0.15"]);
  });

  it("drops error cells and collapses newlines inside a cell", async () => {
    const path = await buildWorkbook("noise.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Noise");
      const header = sheet.addRow(["Material\nSAP Number", "Broken", "Note"]);
      header.getCell(1).alignment = { wrapText: true };
      const row = sheet.addRow(["7100039311", null, "line one\nline two"]);
      row.getCell(2).value = { error: "#DIV/0!" } as ExcelJS.CellErrorValue;
    });

    const { chunks } = await extractXlsx(path);

    // A row must stay a single line — the chunker groups whole rows, and a
    // stray newline would make one row look like two.
    expect(rowLines(chunks[0].text)).toEqual([
      "Material SAP Number: 7100039311; Note: line one line two",
    ]);
  });
});

describe("hidden content is excluded by default", () => {
  it("excludes hidden and very-hidden sheets, and reports that it did", async () => {
    const path = await buildWorkbook("hidden-sheets.xlsx", (workbook) => {
      const visible = workbook.addWorksheet("Visible");
      visible.addRow(["Key"]);
      visible.addRow(["public value"]);

      const hidden = workbook.addWorksheet("Draft");
      hidden.addRow(["Key"]);
      hidden.addRow(["internal draft value"]);
      hidden.state = "hidden";

      const veryHidden = workbook.addWorksheet("Scratch");
      veryHidden.addRow(["Key"]);
      veryHidden.addRow(["scratch value"]);
      veryHidden.state = "veryHidden";
    });

    const result = await extractXlsx(path);

    expect(result.sheets).toEqual(["Visible"]);
    expect(result.hiddenSheets).toEqual(["Draft", "Scratch"]);
    expect(result.chunks.map((chunk) => chunk.sheet)).toEqual(["Visible"]);
    const allText = result.chunks.map((chunk) => chunk.text).join("\n");
    expect(allText).not.toContain("internal draft");
    expect(allText).not.toContain("scratch value");
  });

  it("excludes hidden rows and hidden columns, and reports the row count", async () => {
    const path = await buildWorkbook("hidden-rows.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Prices");
      sheet.addRow(["Article", "List price", "Purchase price"]);
      sheet.addRow(["A-1", 100, 42]);
      sheet.addRow(["A-2", 200, 84]);
      sheet.getRow(3).hidden = true;
      sheet.getColumn(3).hidden = true;
    });

    const result = await extractXlsx(path);

    expect(result.hiddenRows).toBe(1);
    expect(rowLines(result.chunks[0].text)).toEqual(["Article: A-1; List price: 100"]);
    expect(result.chunks[0].text).not.toContain("42");
  });

  it("reports zero chunks with a reason when every sheet is hidden", async () => {
    const path = await buildWorkbook("all-hidden.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Draft");
      sheet.addRow(["Key"]);
      sheet.addRow(["value"]);
      sheet.state = "hidden";
    });

    const result = await extractXlsx(path);

    // Nothing to index, but this is a governance decision rather than an
    // unreadable file — the caller has to be able to tell the two apart.
    expect(result.chunks).toEqual([]);
    expect(result.sheets).toEqual([]);
    expect(result.hiddenSheets).toEqual(["Draft"]);
  });
});

describe("chunking", () => {
  it("splits a long sheet into chunks that respect the token bound", async () => {
    const path = await buildWorkbook("long.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Packaging");
      sheet.addRow(["Material", "Unit"]);
      for (let i = 1; i <= 40; i++) {
        sheet.addRow([`70000018${String(i).padStart(2, "0")}`, "CV"]);
      }
    });

    // 20 tokens ~ 80 chars: small enough to force several chunks over 40 rows.
    const { chunks } = await extractXlsx(path, { targetTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(20 * 4);
      expect(chunk.sheet).toBe("Packaging");
    }
  });

  it("emits every row exactly once, in order, across the chunk boundaries", async () => {
    const path = await buildWorkbook("coverage.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Packaging");
      sheet.addRow(["Material"]);
      for (let i = 1; i <= 40; i++) sheet.addRow([`row-${i}`]);
    });

    const { chunks } = await extractXlsx(path, { targetTokens: 20 });

    // Rows are the atomic unit here, so chunks do NOT overlap the way the PDF
    // chunker does: a duplicated row would be a duplicated fact and would make
    // the row-range anchor ambiguous.
    const emitted = chunks.flatMap((chunk) => rowLines(chunk.text));
    expect(emitted).toEqual(Array.from({ length: 40 }, (_, i) => `Material: row-${i + 1}`));

    // Anchors have to tile the sheet: each chunk starts right after the
    // previous one ends.
    expect(chunks[0].startRow).toBe(2);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startRow).toBeGreaterThan(chunks[i - 1].endRow);
    }
    expect(chunks.at(-1)!.endRow).toBe(41);
  });

  it("emits a row that alone exceeds the budget as its own chunk rather than cutting it", async () => {
    const path = await buildWorkbook("oversized.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Wide");
      sheet.addRow(["Description"]);
      sheet.addRow(["x".repeat(500)]);
      sheet.addRow(["short"]);
    });

    const { chunks } = await extractXlsx(path, { targetTokens: 20 });

    expect(chunks[0].text).toContain("x".repeat(500));
    expect(chunks[0]).toMatchObject({ startRow: 2, endRow: 2 });
    expect(chunks[1]).toMatchObject({ startRow: 3, endRow: 3 });
  });

  it("returns no chunks for a sheet that holds only a header row", async () => {
    const path = await buildWorkbook("header-only.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Empty");
      sheet.addRow(["Article", "Description"]);
    });

    const { chunks, sheets } = await extractXlsx(path);

    expect(sheets).toEqual(["Empty"]);
    expect(chunks).toEqual([]);
  });
});

describe("unreadable files fail at document level", () => {
  it("throws with a reason for a file that is not a zip at all", async () => {
    const path = join(tmpRoot, "corrupt.xlsx");
    await writeFile(path, "this is plain text, not a workbook");

    await expect(extractXlsx(path)).rejects.toThrow(XlsxExtractionError);
    await expect(extractXlsx(path)).rejects.toThrow(/corrupt\.xlsx/);
  });

  it("throws for a legacy binary .xls, which exceljs cannot read", async () => {
    // exceljs reads .xlsx as a zip, so no OLE2 container gets past the opener,
    // whatever its BIFF payload — legacy Excel is out of scope for this
    // extractor and has to say so loudly.
    const path = join(tmpRoot, "legacy.xls");
    await writeFile(path, Buffer.concat([OLE2_MAGIC, Buffer.alloc(512)]));

    await expect(extractXlsx(path)).rejects.toThrow(XlsxExtractionError);
  });

  it("throws for a missing file", async () => {
    await expect(extractXlsx(join(tmpRoot, "nope.xlsx"))).rejects.toThrow(XlsxExtractionError);
  });

  it("throws for a valid zip that holds no worksheets", async () => {
    // This is the silent-zero trap: a .docx renamed .xlsx unzips fine and
    // exceljs resolves happily with zero worksheets. Returning [] here would
    // book a document nobody can read as a successfully indexed empty one.
    const path = await buildWorkbook("no-sheets.xlsx", () => {});

    await expect(extractXlsx(path)).rejects.toThrow(XlsxExtractionError);
    await expect(extractXlsx(path)).rejects.toThrow(/no worksheets/i);
  });

  it("reports a failure raised while walking the workbook as a document-level failure", async () => {
    const path = await buildWorkbook("walk-explodes.xlsx", (workbook) => {
      const sheet = workbook.addWorksheet("Data");
      sheet.addRow(["Key"]);
      sheet.addRow(["value"]);
    });

    // The file opens fine and only the walk fails. Without a net that surfaces
    // as a raw TypeError from library internals, which the caller cannot tell
    // apart from a systemic fault — so a per-file problem would look like a
    // reason to abort the whole ingest run.
    const spy = vi.spyOn(ExcelJS.Workbook.prototype, "worksheets", "get").mockImplementation(() => {
      throw new TypeError("value.text.replace is not a function");
    });
    try {
      await expect(extractXlsx(path)).rejects.toThrow(XlsxExtractionError);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the source path on the error so the caller can name the document", async () => {
    const path = join(tmpRoot, "corrupt.xlsx");
    await writeFile(path, "nope");

    const error = await extractXlsx(path).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(XlsxExtractionError);
    expect((error as XlsxExtractionError).sourcePath).toBe(path);
    expect((error as XlsxExtractionError).cause).toBeInstanceOf(Error);
  });
});

/**
 * The two real corpus files from the issue. They are a customer's 3M vendor
 * data and this repository is public, so they are not committed; point
 * KB_XLSX_CORPUS_DIR at a directory holding them to run this block:
 *
 *   KB_XLSX_CORPUS_DIR="/path/to/Technical Information" pnpm -C packages/web test xlsx-extract
 */
const CORPUS_DIR = process.env.KB_XLSX_CORPUS_DIR;
const CORPUS_FILES = {
  storage: "3M Products ALL - Storage Conditions 01_2019.xlsx",
  packaging: "3M_Packaging_Dimensions_export_pack_levels_by_ean_code_-_2022.xlsx",
} as const;

describe.skipIf(
  !CORPUS_DIR || !Object.values(CORPUS_FILES).every((f) => existsSync(join(CORPUS_DIR, f)))
)("real corpus files (opt-in via KB_XLSX_CORPUS_DIR)", () => {
  it("reads the storage-conditions sheet, carrying its merged category down", async () => {
    const { chunks, sheets } = await extractXlsx(join(CORPUS_DIR!, CORPUS_FILES.storage));

    expect(sheets).toEqual(["FSD Storage"]);
    expect(chunks.length).toBeGreaterThan(0);

    // Column A holds the product family in a cell merged over rows 3-10, so
    // only row 3 physically carries the text. Asserted on the ROW line rather
    // than the chunk: a chunk-level match would also pass if the category came
    // from a neighbouring row that happens to share the chunk.
    const line = chunks
      .flatMap((chunk) => rowLines(chunk.text))
      .find((row) => row.includes("7100039395"));
    expect(line).toBeDefined();
    expect(line).toContain("Petrifilm Rapid");
    expect(line).toContain("2-8°C");
  }, 30_000);

  it("reads every data row of the packaging export without losing one", async () => {
    const { chunks } = await extractXlsx(join(CORPUS_DIR!, CORPUS_FILES.packaging));

    // The sheet reports 1394 rows: one header, 1392 data rows, and a trailing
    // ghost row 1394 that the SAP export left behind — it holds 32 cells, all
    // of them the empty string. It is dropped like any other blank row, which
    // is why the last anchor is 1393 and not 1394.
    const rowCount = chunks.reduce((sum, chunk) => sum + rowLines(chunk.text).length, 0);
    expect(rowCount).toBe(1392);
    expect(chunks[0].startRow).toBe(2);
    expect(chunks.at(-1)!.endRow).toBe(1393);

    // Header labels ride along with their value, so a column that is blank for
    // a given row costs that row nothing. This export has 31 columns and most
    // rows fill a dozen — labelling the blanks too would roughly double the
    // token bill for no added meaning.
    expect(chunks[0].text).toContain("EAN/UPC: 50021200186634");
    expect(rowLines(chunks[0].text)[2]).not.toContain("Unit of Dimension");
    // exceljs's own readFile costs ~4.5 s on this 192 KB / 43k-cell workbook;
    // walking and rendering it afterwards costs ~0.2 s. The default 5 s test
    // timeout is not enough for a file of this size.
  }, 30_000);
});

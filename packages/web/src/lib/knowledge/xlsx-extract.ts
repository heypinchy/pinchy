/**
 * Spreadsheet extractor for the knowledge-base ingest pipeline.
 *
 * Spreadsheets deliberately do NOT go through the Office→PDF conversion path
 * its sibling formats take. Three reasons, in order of weight:
 *
 *  - The anchor would be meaningless. A 40-column sheet laid out onto pages
 *    becomes dozens of unreadable pages, and a citation saying "page 17" gives
 *    the reader nothing to verify. Sheet + row range is intrinsic to the
 *    document rather than to a renderer, so it is both meaningful and stable.
 *  - Page-fitting is the step that silently clips: text too wide for its
 *    column is cut when the sheet is paginated. Reading cells skips that step
 *    entirely, so reading is HIGHER fidelity here, not lower.
 *  - It saves installing `libreoffice-calc` (~103 MB) in the image.
 *
 * The chunk shape follows current practice for tabular RAG (structure-aware
 * chunking): each row becomes a self-contained `Label: value` block, and whole
 * rows are grouped under a token bound. Fixed-size text chunking is documented
 * to tear row structure apart, and the sheet+row-range anchor falls out of the
 * row-wise shape for free.
 *
 *  - Structure-Aware Chunking for Tabular Data in RAG — arxiv.org/pdf/2605.00318
 *  - Sheet as Token: multi-sheet spreadsheet understanding — arxiv.org/pdf/2605.05811
 *
 * Wiring this into ingest.ts is a separate change; this module is standalone
 * and knows nothing about documents, chunk rows or embeddings.
 */
import ExcelJS from "exceljs";

/** A group of whole rows from ONE sheet, anchored on the sheet name and an inclusive row range. */
export interface XlsxChunk {
  text: string;
  /** Sheet name exactly as the workbook spells it — half of the citation anchor. */
  sheet: string;
  /** First row in the chunk, 1-based, as Excel's own row gutter numbers it. */
  startRow: number;
  /** Last row in the chunk, inclusive, 1-based. */
  endRow: number;
}

export interface XlsxExtraction {
  chunks: XlsxChunk[];
  /** Sheets that were read, in workbook order. */
  sheets: string[];
  /**
   * Sheets excluded because their author hid them. Reported rather than merely
   * skipped: without it, a workbook whose every sheet is hidden is
   * indistinguishable from an empty one, and "0 chunks" is exactly the answer
   * an unreadable file gives.
   */
  hiddenSheets: string[];
  /** Rows excluded across all read sheets because their author hid them. */
  hiddenRows: number;
}

export interface XlsxExtractOptions {
  /** Approximate chunk size bound in tokens. Defaults to 512, matching chunk.ts. */
  targetTokens?: number;
}

/**
 * This spreadsheet could not be read at all — not a zip, not a workbook, gone
 * from disk. Deliberately an exception rather than an empty result: a silent
 * zero looks exactly like a successfully indexed empty document, and a
 * document nobody can read must never be booked as one nobody wrote anything
 * in.
 */
export class XlsxExtractionError extends Error {
  constructor(
    readonly sourcePath: string,
    reason: string,
    options?: { cause?: unknown }
  ) {
    super(`Cannot read spreadsheet ${sourcePath}: ${reason}`, options);
    this.name = "XlsxExtractionError";
  }
}

// Same char-per-token heuristic and default target as chunk.ts, so a mixed
// corpus produces comparably-sized chunks whatever the source format.
const CHARS_PER_TOKEN = 4;
const DEFAULT_TARGET_TOKENS = 512;

/** One kept row: its Excel row number and its rendered single-line key-value block. */
interface SheetRow {
  number: number;
  text: string;
}

interface SheetContent {
  name: string;
  rows: SheetRow[];
}

/** Collapses every whitespace run — newlines included — so one cell can never turn one row into two lines. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A date-only cell renders as its calendar date; anything with a time keeps the full ISO stamp. */
function renderDate(value: Date): string {
  const iso = value.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/**
 * Renders a cell the way its reader sees it, or "" for a cell that carries no
 * readable content.
 *
 * Formula cells contribute their CACHED RESULT, never the formula source: the
 * reader sees `20`, not `=B2*10`, and indexing the source would make the
 * document answer questions with text that appears nowhere on screen. A
 * formula the writer never calculated has no result to show and contributes
 * nothing — same rule, applied honestly.
 */
function renderCellValue(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return normalizeWhitespace(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return renderDate(value);
  if (typeof value !== "object") return "";

  // An error cell (#DIV/0!, #N/A) is a broken cell, not knowledge. Indexing
  // the code would put hundreds of identical error strings into the corpus.
  if ("error" in value) return "";

  if ("richText" in value) {
    return normalizeWhitespace(value.richText.map((run) => run.text).join(""));
  }
  if ("hyperlink" in value) {
    const text = normalizeWhitespace(value.text ?? "");
    const href = normalizeWhitespace(value.hyperlink ?? "");
    if (!href || href === text) return text;
    return text ? `${text} (${href})` : href;
  }
  if ("formula" in value || "sharedFormula" in value) {
    return renderCellValue(value.result ?? null);
  }
  return "";
}

/** "B7" -> "B". The fallback label for a column with no header cell. */
function columnLetter(address: string): string {
  return address.replace(/\d+$/, "");
}

/** Is this cell's raw value a text value? Only an all-text row can be a header row. */
function isTextCell(value: ExcelJS.CellValue): boolean {
  return (
    typeof value === "string" ||
    (typeof value === "object" && value !== null && "richText" in value)
  );
}

/**
 * Reads one worksheet into rendered rows, applying the two exclusions this
 * module makes on governance grounds (hidden rows, hidden columns) and turning
 * the first row into column labels when it looks like a header.
 */
function readSheet(worksheet: ExcelJS.Worksheet): { rows: SheetRow[]; hiddenRows: number } {
  const isHiddenColumn = (col: number) => worksheet.getColumn(col).hidden === true;

  const rows: SheetRow[] = [];
  let hiddenRows = 0;
  let headers: Map<number, string> | null = null;
  let headerDecided = false;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (row.hidden) {
      hiddenRows++;
      return;
    }

    // Collect the row's visible, non-empty cells once; both the header
    // decision and the rendered block are built from this.
    const cells: Array<{ column: number; letter: string; raw: ExcelJS.CellValue; text: string }> =
      [];
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (isHiddenColumn(colNumber)) return;
      const text = renderCellValue(cell.value);
      if (!text) return;
      cells.push({ column: colNumber, letter: columnLetter(cell.address), raw: cell.value, text });
    });

    if (cells.length === 0) return;

    // The first row with content decides: an all-text row is the header and
    // becomes the labels; anything else (a number, a date, a formula) means
    // the sheet starts straight into data and columns are labelled by letter.
    if (!headerDecided) {
      headerDecided = true;
      if (cells.every((cell) => isTextCell(cell.raw))) {
        headers = new Map(cells.map((cell) => [cell.column, cell.text]));
        return;
      }
    }

    const text = cells
      .map((cell) => `${headers?.get(cell.column) ?? cell.letter}: ${cell.text}`)
      .join("; ");
    rows.push({ number: rowNumber, text });
  });

  return { rows, hiddenRows };
}

/**
 * Groups whole rows of one sheet into chunks under `targetChars`.
 *
 * Unlike the PDF chunker there is NO overlap between consecutive chunks: a row
 * is the atomic unit of a spreadsheet, so repeating one would duplicate a fact
 * and leave the row-range anchor ambiguous about where that fact lives. A row
 * that alone exceeds the bound is emitted intact as its own oversized chunk
 * rather than being cut — a half row is a wrong row, not a smaller one.
 */
function chunkSheet(sheet: SheetContent, targetChars: number): XlsxChunk[] {
  const prefix = `Sheet: ${sheet.name}`;
  const chunks: XlsxChunk[] = [];

  let rows: string[] = [];
  let startRow = 0;
  let endRow = 0;
  let length = 0;

  const flush = () => {
    if (rows.length === 0) return;
    chunks.push({ text: [prefix, ...rows].join("\n"), sheet: sheet.name, startRow, endRow });
    rows = [];
  };

  for (const row of sheet.rows) {
    if (rows.length > 0 && length + 1 + row.text.length <= targetChars) {
      rows.push(row.text);
      endRow = row.number;
      length += 1 + row.text.length;
      continue;
    }
    flush();
    rows = [row.text];
    startRow = row.number;
    endRow = row.number;
    length = prefix.length + 1 + row.text.length;
  }
  flush();

  return chunks;
}

/**
 * Extracts row-wise chunks from the spreadsheet at `absPath`, anchored on sheet
 * name and row range.
 *
 * Hidden sheets, rows and columns are excluded. That is a governance decision,
 * not a formatting one: indexing what the author hid makes the citation
 * unverifiable for the reader, who opens the file and does not see it. The
 * result reports what was excluded so a zero-chunk workbook can still explain
 * itself.
 *
 * Only OOXML `.xlsx` is readable — exceljs has no BIFF reader, so a legacy
 * binary `.xls` (an OLE2 container, not a zip) fails at the opener like any
 * other unreadable file. That is the intended outcome: loud, with a reason.
 *
 * @throws XlsxExtractionError if the file cannot be read as a workbook.
 */
export async function extractXlsx(
  absPath: string,
  opts: XlsxExtractOptions = {}
): Promise<XlsxExtraction> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(absPath);
  } catch (err) {
    throw new XlsxExtractionError(absPath, "the file could not be opened as a workbook", {
      cause: err,
    });
  }

  // Excel cannot save a workbook without a sheet, so zero worksheets means we
  // opened something that merely LOOKS like one — a .docx renamed .xlsx unzips
  // fine and lands exactly here. exceljs reports that as a clean, empty
  // success, which is the silent-zero this extractor exists to refuse.
  if (workbook.worksheets.length === 0) {
    throw new XlsxExtractionError(absPath, "the file opened but contains no worksheets");
  }

  const targetChars = (opts.targetTokens ?? DEFAULT_TARGET_TOKENS) * CHARS_PER_TOKEN;

  const sheets: string[] = [];
  const hiddenSheets: string[] = [];
  const chunks: XlsxChunk[] = [];
  let hiddenRows = 0;

  for (const worksheet of workbook.worksheets) {
    if (worksheet.state === "hidden" || worksheet.state === "veryHidden") {
      hiddenSheets.push(worksheet.name);
      continue;
    }
    sheets.push(worksheet.name);
    const sheet = readSheet(worksheet);
    hiddenRows += sheet.hiddenRows;
    chunks.push(...chunkSheet({ name: worksheet.name, rows: sheet.rows }, targetChars));
  }

  return { chunks, sheets, hiddenSheets, hiddenRows };
}

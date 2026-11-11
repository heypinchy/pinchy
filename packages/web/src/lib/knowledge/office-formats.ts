/**
 * What counts as a page-shaped Office document, and what its converted PDF is
 * called. Two facts, needed on BOTH sides of the bundle boundary.
 *
 * No imports on purpose — same rule as `citation-path.ts`. The markdown
 * renderer decides client-side whether a citation is an Office source (it
 * offers a second download for one), and `office-convert.ts` decides the same
 * thing server-side. A single `node:path` import here would drag
 * `child_process` and pdfjs into the browser bundle along the same chain, so
 * the extension is read with string operations rather than `extname`.
 *
 * These constants used to live in `office-convert.ts`; they moved here when
 * the preview route (#939) and the renderer needed them, so the list stays one
 * list. `office-convert.ts` re-exports them, which is why its own tests still
 * read the same names.
 */

/**
 * The page-shaped Office formats. Spreadsheets are deliberately absent: a
 * sheet is not a page, and rendering one to PDF produces arbitrary page breaks
 * that no citation can honestly point at (#937/#940).
 */
export const OFFICE_EXTENSIONS = [".doc", ".docx", ".ppt", ".pptx"] as const;

/**
 * The two halves of that list, because they are anchored differently and the
 * split is the whole of #938's dispatch: a presentation's slide N IS the
 * converted PDF's page N, while a Word document's pages belong to the renderer
 * and its citations ride the heading outline instead (locator.ts).
 *
 * Derived from `OFFICE_EXTENSIONS` by partition rather than re-typed, so a
 * fifth format cannot be added to the list above and silently belong to
 * neither anchor — `office-formats.test.ts` pins the two halves to cover it.
 */
export const WORD_EXTENSIONS = [".doc", ".docx"] as const;
export const PRESENTATION_EXTENSIONS = [".ppt", ".pptx"] as const;

/**
 * Documents per converter process.
 *
 * Big enough that LibreOffice's startup is amortised (17 real corpus files cost
 * 14.2 s in one process against 25.6 s one-per-file), small enough that an OOM
 * kill or a timeout — after which every document of the batch is run again on
 * its own (`office-convert.ts`) — costs bounded re-work.
 *
 * It lives in this import-free module because BOTH sides of the batch need it
 * and neither may hold its own copy: `office-convert.ts` sizes the process, and
 * `ingest.ts` slices the queue it hands over. A second number in the slicer
 * would silently cap the one that was measured, with nothing to notice — and
 * the slicer cannot simply import the converter, whose module graph carries
 * `child_process` and pdfjs.
 */
export const OFFICE_CONVERT_BATCH_SIZE = 20;

/**
 * The spreadsheet formats the knowledge base reads cell by cell, instead of
 * rendering them to pages (see `xlsx-extract.ts` for the three reasons).
 *
 * `extractXlsx` reads through `workbook.xlsx.readFile`, which parses the zipped
 * OOXML formats and not legacy BIFF. `.xls` is on this list anyway, because it
 * never reaches that reader as itself: the office converter turns it into an
 * `.xlsx` first (`LEGACY_WORKBOOK_EXTENSIONS`, #1373), and what the reader
 * opens is that. What a legacy workbook IS does not change with the route —
 * cited by sheet and rows, shown in the sheet pane, admitted by discovery.
 *
 * `.csv` is out for a different reason: it has no sheet, so half of the
 * `sheet + rows` anchor would have to be invented.
 */
export const SPREADSHEET_EXTENSIONS = [".xlsx", ".xlsm", ".xls"] as const;

/**
 * The spreadsheets the converter turns into `.xlsx` before they are read.
 *
 * Legacy BIFF8 workbooks: exceljs cannot parse them, and the JavaScript
 * readers that can either carry open advisories on their npm release or ship
 * fixes off-registry. LibreOffice Calc in the network-less converter sidecar
 * reads them instead, and the spreadsheet reader then gets the same OOXML it
 * gets from any other workbook — with the same limits.
 */
export const LEGACY_WORKBOOK_EXTENSIONS = [".xls"] as const;

/**
 * Every format the office converter takes: the page-shaped documents it turns
 * into PDFs and the legacy workbooks it turns into `.xlsx`.
 *
 * One list, because the converter's queue, the sidecar's input check and the
 * artifact version an indexed row records must all agree on it — a format the
 * converter takes that one of them leaves out is converted and then never
 * asked for, or asked for and refused.
 */
export const CONVERTED_EXTENSIONS = [...OFFICE_EXTENSIONS, ...LEGACY_WORKBOOK_EXTENSIONS] as const;

/**
 * The lowercased extension of `path`, or "" — `node:path`'s `extname` written
 * as string surgery, including its rule that a leading dot is a dotfile and
 * not an extension (`.doc` → "", never ".doc").
 */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Is this a page-shaped Office document the knowledge base converts? */
export function isOfficeFile(path: string): boolean {
  return (OFFICE_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/** Is this a spreadsheet the knowledge base reads directly, rather than converts? */
export function isSpreadsheetFile(path: string): boolean {
  return (SPREADSHEET_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/** Is this a legacy BIFF workbook, read through its converted `.xlsx`? */
export function isLegacyWorkbook(path: string): boolean {
  return (LEGACY_WORKBOOK_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/** Does the office converter have to run before this file can be read? */
export function needsConversion(path: string): boolean {
  return (CONVERTED_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/** The two formats the converter writes. */
export const CONVERTED_OUTPUT_EXTENSIONS = [".pdf", ".xlsx"] as const;
export type ConvertedExtension = (typeof CONVERTED_OUTPUT_EXTENSIONS)[number];

/**
 * What the converter turns `path` into: `.pdf` for a page-shaped document,
 * `.xlsx` for a legacy workbook. Throws for anything it does not convert,
 * because a guessed target would be stored, and looked up, under a name
 * nothing ever writes.
 */
export function convertedExtensionOf(path: string): ConvertedExtension {
  if (isOfficeFile(path)) return ".pdf";
  if (isLegacyWorkbook(path)) return ".xlsx";
  throw new Error(`not a format the office converter takes: ${path}`);
}

/** Is this a Word document — the format anchored on its heading outline? */
export function isWordFile(path: string): boolean {
  return (WORD_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/** Is this a presentation — the format whose slide N is the converted PDF's page N? */
export function isPresentationFile(path: string): boolean {
  return (PRESENTATION_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/**
 * What the converted PDF is called: the source's own name, carrying `.pdf`.
 *
 * `Angebot.doc` → `Angebot.pdf`, so the two downloads a reader is offered name
 * the same document and differ exactly where they differ — in the format. A
 * generic `converted.pdf` would arrive in their downloads folder saying
 * nothing about which document it is.
 */
export function convertedPdfName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = extensionOf(name);
  return `${ext ? name.slice(0, -ext.length) : name}.pdf`;
}

/**
 * Why an Office file was refused BEFORE any reader touched it.
 *
 * - `too_large`   — the file, or what its zip central directory says it
 *                   inflates to, is past what we will load into the web
 *                   process. A decompression bomb takes this exit; so does a
 *                   genuinely enormous workbook, and that is deliberate — the
 *                   reader (exceljs, mammoth, LibreOffice) materialises the
 *                   whole thing and the cost is the same. The spreadsheet
 *                   reader's child process running out of memory or time
 *                   (`xlsx-isolated.ts`) is booked the same way.
 * - `unexpected_content` — the bytes are not the format the extension claims
 *                   (HTML renamed `.doc`, an ODF package renamed `.docx`).
 *                   LibreOffice sniffs content, not names, so such a file would
 *                   be imported by a filter the extension never promised — one
 *                   that fetches linked content.
 *
 * It lives in this import-free module because the ingest, the converter, the
 * spreadsheet reader and the workspace-file route all need to tell "this
 * document is refused" from "this reader broke", and none of them may pull the
 * others' dependencies (exceljs, `child_process`) to do it.
 */
export class OfficeFileRejectedError extends Error {
  constructor(
    readonly code: "too_large" | "unexpected_content",
    message: string
  ) {
    super(message);
    this.name = "OfficeFileRejectedError";
  }
}

/**
 * The checked copy of an Office file could not be written where the converter
 * reads it: a full, read-only or failing artifact volume. Thrown for the
 * DESTINATION only — a source that cannot be read is about the document —
 * because nothing here is a verdict on the file: the converter books it as
 * infrastructure, retried next run, and the index keeps what it had.
 */
export class StagedCopyWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagedCopyWriteError";
  }
}

/**
 * One word-splitting rule for both sides of the conversion's comparison — two
 * rules would make the bound meaningless. Here, in the import-free module,
 * because the word-count reader's child counts with it too.
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

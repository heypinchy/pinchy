import { describe, it, expect } from "vitest";
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  isAllowedExtension,
  isDenylistedDirName,
  isDenylistedFileName,
  isHiddenSegment,
} from "@/lib/knowledge/exclude-globs";

describe("isHiddenSegment", () => {
  it("treats a dotfile as hidden", () => {
    expect(isHiddenSegment(".DS_Store")).toBe(true);
    expect(isHiddenSegment(".git")).toBe(true);
  });

  it("treats a normal file/dir name as not hidden", () => {
    expect(isHiddenSegment("handbook.pdf")).toBe(false);
    expect(isHiddenSegment("2020")).toBe(false);
  });
});

describe("isAllowedExtension", () => {
  it("defaults to PDFs and the OOXML workbooks (#940)", () => {
    expect(DEFAULT_ALLOWED_EXTENSIONS).toEqual([".pdf", ".xlsx", ".xlsm"]);
    expect(isAllowedExtension("handbook.pdf")).toBe(true);
    expect(isAllowedExtension("handbook.PDF")).toBe(true);
    expect(isAllowedExtension("Lieferanten.xlsx")).toBe(true);
    expect(isAllowedExtension("Makros.xlsm")).toBe(true);
    // A share written from Windows routinely spells the extension in caps, and
    // discovery is the ONLY place that lowercases before matching — a file
    // admitted here is handed straight to `isSpreadsheetFile`, which lowercases
    // too. The pair is asserted from both sides so it cannot drift into
    // "admitted by the allowlist, dispatched to the PDF extractor".
    expect(isAllowedExtension("LIEFERANTEN.XLSX")).toBe(true);
    expect(isAllowedExtension("handbook.docx")).toBe(false);
    expect(isAllowedExtension("handbook.txt")).toBe(false);
    // The two spreadsheet formats deliberately left out, each for its own
    // reason (office-formats.ts): `.xls` is BIFF, which the extractor cannot
    // open, and `.csv` has no sheet to anchor half a citation on.
    expect(isAllowedExtension("Preise.xls")).toBe(false);
    expect(isAllowedExtension("export.csv")).toBe(false);
  });

  it("honors an overridden allowlist", () => {
    expect(isAllowedExtension("notes.txt", [".txt", ".md"])).toBe(true);
    expect(isAllowedExtension("handbook.pdf", [".txt", ".md"])).toBe(false);
  });
});

describe("isDenylistedFileName", () => {
  it("flags OS-artifact exact names case-insensitively", () => {
    expect(isDenylistedFileName("Thumbs.db")).toBe(true);
    expect(isDenylistedFileName("desktop.ini")).toBe(true);
    expect(isDenylistedFileName("DESKTOP.INI")).toBe(true);
  });

  it("flags AppleDouble and Office lock-file prefixes", () => {
    expect(isDenylistedFileName("._resource-fork")).toBe(true);
    expect(isDenylistedFileName("~$report.docx")).toBe(true);
  });

  it("flags temp/backup suffixes", () => {
    expect(isDenylistedFileName("download.crdownload")).toBe(true);
    expect(isDenylistedFileName("upload.part")).toBe(true);
    expect(isDenylistedFileName("handbook.pdf.tmp")).toBe(true);
    expect(isDenylistedFileName("handbook.pdf.bak")).toBe(true);
    expect(isDenylistedFileName("handbook.pdf~")).toBe(true);
    expect(isDenylistedFileName("handbook.pdf.swp")).toBe(true);
  });

  it("does not flag a normal document name", () => {
    expect(isDenylistedFileName("handbook.pdf")).toBe(false);
    expect(isDenylistedFileName("Q3-report.pdf")).toBe(false);
  });
});

describe("isDenylistedDirName", () => {
  it("flags OS-reserved junk folders case-insensitively", () => {
    expect(isDenylistedDirName("$RECYCLE.BIN")).toBe(true);
    expect(isDenylistedDirName("System Volume Information")).toBe(true);
  });

  it("does NOT flag archive/date folders (that's a query-time filter, not an ingest default)", () => {
    expect(isDenylistedDirName("OLD")).toBe(false);
    expect(isDenylistedDirName("Archive")).toBe(false);
    expect(isDenylistedDirName("2020")).toBe(false);
    expect(isDenylistedDirName("Q3")).toBe(false);
  });
});

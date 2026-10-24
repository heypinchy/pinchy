/**
 * The two facts both the converter and the browser need about an Office
 * source: is it one, and what is its converted PDF called (#939).
 *
 * `isOfficeFile` is also exercised through `office-convert.ts`'s re-export in
 * `office-convert.test.ts`; what is pinned HERE is the behaviour that only
 * matters now that a client component reads the same module — the extension is
 * parsed with string operations rather than `node:path`, so the cases where
 * `extname` is surprising are the ones worth writing down.
 */
import { describe, it, expect } from "vitest";

import {
  convertedPdfName,
  isOfficeFile,
  isPresentationFile,
  isSpreadsheetFile,
  isWordFile,
  OFFICE_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  WORD_EXTENSIONS,
} from "@/lib/knowledge/office-formats";

describe("isOfficeFile", () => {
  it("recognises every converted format, whatever the case", () => {
    for (const ext of OFFICE_EXTENSIONS) {
      expect(isOfficeFile(`/data/report${ext}`)).toBe(true);
      expect(isOfficeFile(`/data/report${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it("says no to the formats that take a different path", () => {
    // Spreadsheets are read directly (#937) and PDFs need no conversion at all.
    expect(isOfficeFile("/data/budget.xlsx")).toBe(false);
    expect(isOfficeFile("/data/budget.xls")).toBe(false);
    expect(isOfficeFile("/data/report.pdf")).toBe(false);
    expect(isOfficeFile("/data/notes")).toBe(false);
  });

  it("reads the extension of the FILE, not of a directory above it", () => {
    // A folder called `2019.doc` holding a PDF is not an Office document, and
    // an `endsWith` over the whole path would say it is.
    expect(isOfficeFile("/data/2019.doc/report.pdf")).toBe(false);
    expect(isOfficeFile("/data/2019.pdf/report.doc")).toBe(true);
  });

  it("treats a leading dot as a dotfile rather than an extension", () => {
    // `extname("/data/.doc")` is "", and this must agree with it — the
    // converter and the preview route would otherwise disagree about what
    // exists.
    expect(isOfficeFile("/data/.doc")).toBe(false);
  });
});

describe("convertedPdfName", () => {
  it("keeps the document's own name and changes only the format", () => {
    expect(convertedPdfName("/data/noack/Angebot.doc")).toBe("Angebot.pdf");
    expect(convertedPdfName("Präsentation.pptx")).toBe("Präsentation.pdf");
  });

  it("does not lowercase the name it was given", () => {
    // The label is shown to a reader and the filename lands in their downloads
    // folder; only the EXTENSION is matched case-insensitively.
    expect(convertedPdfName("/data/QF_2012/Bericht.DOC")).toBe("Bericht.pdf");
  });

  it("leaves a doubled extension alone apart from the last one", () => {
    expect(convertedPdfName("/data/report.v2.docx")).toBe("report.v2.pdf");
  });
});

describe("isSpreadsheetFile", () => {
  it("recognises the OOXML workbooks the extractor can open", () => {
    expect(isSpreadsheetFile("/data/quality/Lieferanten.xlsx")).toBe(true);
    expect(isSpreadsheetFile("/data/quality/Makros.xlsm")).toBe(true);
  });

  it("matches the extension case-insensitively, as a Windows share writes it", () => {
    // Not hypothetical for this product: a corpus arriving over SMB routinely
    // carries `.XLSX`. Discovery lowercases (isAllowedExtension) and so must
    // the dispatch, or a file would be admitted to the ingest and then handed
    // to the PDF extractor.
    expect(isSpreadsheetFile("/data/QF_2012/LIEFERANTEN.XLSX")).toBe(true);
    expect(isSpreadsheetFile("/data/QF_2012/Liste.XlSm")).toBe(true);
  });

  it("leaves out the formats the extractor cannot open", () => {
    // `.xls` is BIFF, not OOXML: `workbook.xlsx.readFile` does not parse it,
    // and a `.csv` has no sheet to anchor half the citation on.
    expect(isSpreadsheetFile("/data/legacy/Preise.xls")).toBe(false);
    expect(isSpreadsheetFile("/data/export.csv")).toBe(false);
  });

  it("is not confused by a page-shaped Office document, or by a dotfile", () => {
    expect(isSpreadsheetFile("/data/Angebot.docx")).toBe(false);
    expect(isSpreadsheetFile("/data/.xlsx")).toBe(false);
  });
});

describe("the two halves of OFFICE_EXTENSIONS", () => {
  it("covers every page-shaped format, with nothing in both", () => {
    // The dispatch that gives a Word chunk a heading and a slide chunk a slide
    // number reads these two lists. A format in neither would be admitted to
    // the ingest and then anchored by nothing; a format in both would take
    // whichever branch happens to be tested first.
    expect([...WORD_EXTENSIONS, ...PRESENTATION_EXTENSIONS].sort()).toEqual(
      [...OFFICE_EXTENSIONS].sort()
    );
    expect(
      WORD_EXTENSIONS.filter((ext) => (PRESENTATION_EXTENSIONS as readonly string[]).includes(ext))
    ).toEqual([]);
  });

  it("recognises legacy and OOXML alike, case-insensitively", () => {
    // Legacy is the majority of the reference corpus (13 of 19), and it is
    // exactly what the OOXML-only parsing ecosystem cannot read — the reason
    // both anchors come out of the converted PDF instead.
    expect(isWordFile("/data/QF_2012/Bericht.DOC")).toBe(true);
    expect(isWordFile("/data/Angebot.docx")).toBe(true);
    expect(isPresentationFile("/data/Schulung.PPT")).toBe(true);
    expect(isPresentationFile("/data/Schulung.pptx")).toBe(true);
  });

  it("keeps the two apart, and both away from the formats they do not own", () => {
    expect(isWordFile("/data/Schulung.pptx")).toBe(false);
    expect(isPresentationFile("/data/Angebot.docx")).toBe(false);
    for (const path of ["/data/report.pdf", "/data/Preise.xlsx", "/data/.docx"]) {
      expect(isWordFile(path)).toBe(false);
      expect(isPresentationFile(path)).toBe(false);
    }
  });
});

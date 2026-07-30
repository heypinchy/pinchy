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

import { convertedPdfName, isOfficeFile, OFFICE_EXTENSIONS } from "@/lib/knowledge/office-formats";

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

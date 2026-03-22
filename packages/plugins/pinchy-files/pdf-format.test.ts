import { describe, it, expect } from "vitest";
import { formatPdfResult } from "./pdf-format";
import type { PdfExtractionResult } from "./pdf-extract";

// Helper to create a minimal page
function makePage(
  overrides: Partial<{
    pageNumber: number;
    text: string;
    isScanned: boolean;
    embeddedImages: { width: number; height: number; data: Buffer }[];
  }> = {},
) {
  return {
    pageNumber: overrides.pageNumber ?? 1,
    text: overrides.text ?? "",
    isScanned: overrides.isScanned ?? false,
    embeddedImages: overrides.embeddedImages ?? [],
  };
}

describe("formatPdfResult", () => {
  it("wraps output in XML document tags with source and page count", () => {
    const result: PdfExtractionResult = {
      pages: [makePage({ text: "Hello world" })],
      totalPages: 1,
      truncated: false,
    };
    const output = formatPdfResult(result, "/data/docs/report.pdf");

    expect(output).toContain("<document>");
    expect(output).toContain("<source>/data/docs/report.pdf</source>");
    expect(output).toContain("<pages>1</pages>");
    expect(output).toContain("<document_content>");
    expect(output).toContain("Hello world");
    expect(output).toContain("</document_content>");
    expect(output).toContain("</document>");
  });

  it("does not include inline page markers in the body", () => {
    const result: PdfExtractionResult = {
      pages: [
        makePage({ pageNumber: 1, text: "Page one text" }),
        makePage({ pageNumber: 2, text: "Page two text" }),
      ],
      totalPages: 2,
      truncated: false,
    };
    const output = formatPdfResult(result, "/data/docs/test.pdf");

    expect(output).not.toMatch(/---\s*Page\s*\d/);
    expect(output).toContain("Page one text");
    expect(output).toContain("Page two text");
  });

  it("shows fallback message for scanned pages without text", () => {
    const result: PdfExtractionResult = {
      pages: [makePage({ isScanned: true })],
      totalPages: 1,
      truncated: false,
    };
    const output = formatPdfResult(result, "/data/docs/test.pdf");

    expect(output).toContain("Unable to extract text");
  });

  it("shows truncation notice when pages were limited", () => {
    const result: PdfExtractionResult = {
      pages: [makePage({ text: "First page" })],
      totalPages: 100,
      truncated: true,
    };
    const output = formatPdfResult(result, "/data/docs/huge.pdf");

    expect(output).toContain("100");
    expect(output).toContain("truncated");
  });
});

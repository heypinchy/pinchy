import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PDFDocument } from "pdf-lib";
import { extractPdfText } from "./pdf-extract";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

describe("extractPdfText", () => {
  it("extracts text from a text-only PDF", async () => {
    const buffer = readFileSync(join(FIXTURES, "text-only.pdf"));
    const result = await extractPdfText(buffer);

    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    expect(result.pages[0].text.length).toBeGreaterThan(50);
    expect(result.totalPages).toBe(result.pages.length);
    // Check for key phrases from the golden file
    const expected = readFileSync(
      join(FIXTURES, "text-only.expected.txt"),
      "utf-8",
    );
    for (const phrase of expected.split("\n").filter(Boolean)) {
      const fullText = result.pages.map((p) => p.text).join("\n");
      expect(fullText).toContain(phrase);
    }
  });

  it("marks pages with sparse text as scanned", async () => {
    const buffer = readFileSync(join(FIXTURES, "scanned.pdf"));
    const result = await extractPdfText(buffer);

    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.pages[0].isScanned).toBe(true);
    expect(result.pages[0].text.length).toBeLessThan(200);
  });

  it("renders scanned pages to PNG during extraction", async () => {
    const buffer = readFileSync(join(FIXTURES, "scanned.pdf"));
    const result = await extractPdfText(buffer);

    expect(result.pages[0].isScanned).toBe(true);
    expect(result.pages[0].renderedImage).toBeDefined();
    expect(result.pages[0].renderedImage!.length).toBeGreaterThan(100);
    // PNG magic bytes
    expect(result.pages[0].renderedImage![0]).toBe(0x89);
    expect(result.pages[0].renderedImage![1]).toBe(0x50);
    expect(result.pages[0].renderedImage![2]).toBe(0x4e);
    expect(result.pages[0].renderedImage![3]).toBe(0x47);
  });

  it("does not render non-scanned pages", async () => {
    const buffer = readFileSync(join(FIXTURES, "text-only.pdf"));
    const result = await extractPdfText(buffer);

    for (const page of result.pages) {
      expect(page.isScanned).toBe(false);
      expect(page.renderedImage).toBeUndefined();
    }
  });

  it("extracts table content", async () => {
    const buffer = readFileSync(join(FIXTURES, "with-tables.pdf"));
    const result = await extractPdfText(buffer);

    const fullText = result.pages.map((p) => p.text).join("\n");
    const expected = readFileSync(
      join(FIXTURES, "with-tables.expected.txt"),
      "utf-8",
    );
    for (const phrase of expected.split("\n").filter(Boolean)) {
      expect(fullText).toContain(phrase);
    }
  });

  it("handles mixed PDFs — text and scanned pages", async () => {
    const buffer = readFileSync(join(FIXTURES, "mixed.pdf"));
    const result = await extractPdfText(buffer);

    // First pages should have text
    expect(result.pages[0].isScanned).toBe(false);
    expect(result.pages[0].text.length).toBeGreaterThan(50);

    // Last page should be scanned
    const lastPage = result.pages[result.pages.length - 1];
    expect(lastPage.isScanned).toBe(true);
  });

  it("detects embedded images above size threshold", async () => {
    const buffer = readFileSync(join(FIXTURES, "with-images.pdf"));
    const result = await extractPdfText(buffer);

    const pagesWithImages = result.pages.filter(
      (p) => p.embeddedImages.length > 0,
    );
    expect(pagesWithImages.length).toBeGreaterThanOrEqual(1);
    for (const page of pagesWithImages) {
      for (const img of page.embeddedImages) {
        expect(img.width).toBeGreaterThanOrEqual(100);
        expect(img.height).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it("respects page limit", async () => {
    const buffer = readFileSync(join(FIXTURES, "large-60pages.pdf"));
    const result = await extractPdfText(buffer, { maxPages: 50 });

    expect(result.pages.length).toBe(50);
    expect(result.totalPages).toBe(60);
    expect(result.truncated).toBe(true);
  });

  it("does not mark short text pages without images as scanned", async () => {
    // Create a minimal PDF with just "Hello" on one page — short text, no images.
    // With the old logic (text.length < 200 → scanned), this would be marked as scanned.
    // With the new logic, it should NOT be scanned because there are no large images.
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([200, 200]);
    page.drawText("Hello", { x: 50, y: 100, size: 12 });
    const pdfBytes = await pdfDoc.save();
    const buffer = Buffer.from(pdfBytes);

    const result = await extractPdfText(buffer);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text.length).toBeLessThan(200); // confirms sparse text
    expect(result.pages[0].isScanned).toBe(false); // but NOT scanned (no images)
  });
});

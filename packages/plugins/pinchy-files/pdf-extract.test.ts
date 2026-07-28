// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import PDFDocument from "pdfkit";
import { extractPdfText, isScannedPage, IMAGE_OBJECT_TIMEOUT_MS } from "./pdf-extract";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

/** Build a minimal single-page PDF in-memory with pdfkit. */
function buildPdf(
  build: (doc: PDFKit.PDFDocument) => void,
  size: [number, number]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size, margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

describe("isScannedPage — what happens when the page's images cannot be measured", () => {
  // pdfjs only resolves an image object through `page.objs.get(name, cb)`, which
  // has no promise and no deadline of its own, so pdf-extract wraps it in a
  // timeout. Measured on a loaded machine (load ~236) that callback took 14.0s
  // for a single 1200x1600 scan — nearly 3x the 5s the timeout used to allow.
  //
  // What made that a product bug rather than a slow test: on timeout the old
  // code fell through to `hasLargeImages = false`, so a sparse-text page that
  // paints a full-page image was classified as an ordinary text page. No render,
  // no OCR hand-off — the agent silently received a blank page for a scanned
  // invoice, with nothing anywhere saying a measurement had been dropped.
  //
  // So an unmeasurable image is now evidence FOR a scan, not against one. The
  // page already proved it paints an image; only the size check timed out.
  it("is a scan when a sparse page has a large image", () => {
    expect(isScannedPage({ sparseText: true, hasLargeImages: true, imageSizeUnknown: false })).toBe(
      true
    );
  });

  it("is a scan when a sparse page paints an image we could not measure in time", () => {
    expect(isScannedPage({ sparseText: true, hasLargeImages: false, imageSizeUnknown: true })).toBe(
      true
    );
  });

  it("is not a scan when a sparse page paints no image at all", () => {
    // imageSizeUnknown can only be set by an image that was actually painted, so
    // a page with no paint op reaches this with both flags false and stays text.
    expect(
      isScannedPage({ sparseText: false, hasLargeImages: false, imageSizeUnknown: false })
    ).toBe(false);
    expect(
      isScannedPage({ sparseText: true, hasLargeImages: false, imageSizeUnknown: false })
    ).toBe(false);
  });

  it("is never a scan when the page has plenty of text", () => {
    // A text-rich page with a big illustration is still a text page.
    expect(
      isScannedPage({ sparseText: false, hasLargeImages: true, imageSizeUnknown: false })
    ).toBe(false);
    expect(
      isScannedPage({ sparseText: false, hasLargeImages: false, imageSizeUnknown: true })
    ).toBe(false);
  });

  it("allows enough time for a real decode on a busy machine", () => {
    // The measured worst case was 14.0s. Anything at or below it turns a busy
    // machine back into silently degraded extraction, which is the whole defect.
    expect(IMAGE_OBJECT_TIMEOUT_MS).toBeGreaterThan(14_000);
  });
});

// Real fixtures, real pdfjs, real canvas rendering: a 60-page parse plus PNG
// rasterisation is genuinely seconds of CPU, and with IMAGE_OBJECT_TIMEOUT_MS
// now allowing a slow decode to finish, a single test can legitimately outlast
// vitest's default. The explicit timeout is headroom for slow work, not cover
// for a hang — every assertion below is unchanged.
describe("extractPdfText", { timeout: 180_000 }, () => {
  it("extracts text from a text-only PDF", async () => {
    const buffer = readFileSync(join(FIXTURES, "text-only.pdf"));
    const result = await extractPdfText(buffer);

    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    expect(result.pages[0].text.length).toBeGreaterThan(50);
    expect(result.totalPages).toBe(result.pages.length);
    // Check for key phrases from the golden file
    const expected = readFileSync(join(FIXTURES, "text-only.expected.txt"), "utf-8");
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
    const expected = readFileSync(join(FIXTURES, "with-tables.expected.txt"), "utf-8");
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

    const pagesWithImages = result.pages.filter((p) => p.embeddedImages.length > 0);
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
    const buffer = await buildPdf(
      (doc) => {
        doc.fontSize(12).text("Hello", 50, 100);
      },
      [200, 200]
    );

    const result = await extractPdfText(buffer);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text.length).toBeLessThan(200); // confirms sparse text
    expect(result.pages[0].isScanned).toBe(false); // but NOT scanned (no images)
  });
});

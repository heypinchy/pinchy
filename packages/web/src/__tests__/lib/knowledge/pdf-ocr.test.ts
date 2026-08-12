/**
 * Index-time OCR: what `extractPdfPages` does with a page that carries an
 * image and no usable text layer.
 *
 * The PDFs here are built on the fly (pdfkit + sharp, both already web
 * dependencies) rather than checked in, for the same reason as
 * `pdf-extract.test.ts`: a real pdfjs round trip is the only thing that proves
 * the scan decision reads the document rather than a fixture's file name.
 *
 * The vision call itself is injected as `ocrPage`. That seam is deliberate —
 * it keeps this file a test of the DECISION (which pages are handed over, how
 * many, what happens to the text that comes back) and leaves the provider
 * protocol to `pdf-vision-api.test.ts`, which owns it in the plugin the module
 * is shared from.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PDFDocument from "pdfkit";
import sharp from "sharp";

import { extractPdfPages } from "@/lib/knowledge/pdf-extract";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-pdf-ocr-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A solid-grey PNG — stands in for the bitmap a scanner produces. */
function scanImage(): Promise<Buffer> {
  return sharp({
    create: { width: 620, height: 877, channels: 3, background: { r: 210, g: 210, b: 210 } },
  })
    .png()
    .toBuffer();
}

/**
 * Builds a PDF whose pages are described by `pages`: a string page carries that
 * text, `"scan"` carries a full-page image and no text at all.
 */
async function buildPdf(pages: (string | "scan")[]): Promise<Buffer> {
  const image = pages.includes("scan") ? await scanImage() : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    for (const page of pages) {
      doc.addPage();
      if (page === "scan") {
        doc.image(image!, 0, 0, { width: 612 });
      } else {
        doc.fontSize(12).text(page);
      }
    }
    doc.end();
  });
}

async function writePdf(name: string, pages: (string | "scan")[]): Promise<string> {
  const path = join(tmpRoot, name);
  await writeFile(path, await buildPdf(pages));
  return path;
}

it("hands a page with no text layer to OCR and keeps what comes back", async () => {
  const path = await writePdf("certificate.pdf", ["scan"]);
  const ocrPage = vi.fn(
    async (_image: Buffer) => "AFNOR VALIDATION\nMethod NF VALIDATION certified."
  );

  const pages = await extractPdfPages(path, { ocr: { ocrPage } });

  expect(ocrPage).toHaveBeenCalledTimes(1);
  // What arrives at the vision call is a rendered image of the page, not the
  // PDF bytes — the whole point of the render step.
  const rendered = ocrPage.mock.calls[0][0];
  expect(rendered.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic
  );

  expect(pages).toHaveLength(1);
  expect(pages[0].text).toContain("AFNOR VALIDATION");
});

it("leaves a page that has a text layer alone", async () => {
  // The expensive half of this feature is the render + the provider round
  // trip. A document that never needed OCR must not pay either — this is the
  // assertion that keeps a regression from silently OCRing the whole corpus.
  const path = await writePdf("policy.pdf", [
    "Northwind issues one laptop per employee. ".repeat(20),
  ]);
  const ocrPage = vi.fn(async () => "should never be called");

  const pages = await extractPdfPages(path, { ocr: { ocrPage } });

  expect(ocrPage).not.toHaveBeenCalled();
  expect(pages[0].text).toContain("Northwind issues one laptop");
});

it("OCRs only the scanned pages of a mixed document", async () => {
  const path = await writePdf("mixed.pdf", [
    "Northwind issues one laptop per employee. ".repeat(20),
    "scan",
  ]);
  const ocrPage = vi.fn(async () => "SCANNED APPENDIX");

  const pages = await extractPdfPages(path, { ocr: { ocrPage } });

  expect(ocrPage).toHaveBeenCalledTimes(1);
  expect(pages[0].text).toContain("Northwind issues one laptop");
  expect(pages[1].text).toBe("SCANNED APPENDIX");
});

it("does no OCR at all when none is configured", async () => {
  // The honest degraded state, and the one every install without a vision
  // provider runs in: the scan indexes as an empty page rather than failing
  // the document. #935 owns making that visible.
  const path = await writePdf("certificate.pdf", ["scan"]);

  const pages = await extractPdfPages(path);

  expect(pages).toHaveLength(1);
  expect(pages[0].text).toBe("");
});

it("stops rendering after the page budget, and says how many it skipped", async () => {
  // A 1159-page scan is real (issue #941, the Noack corpus). Without a bound,
  // one document would spend 1159 vision calls at index time.
  const path = await writePdf("huge.pdf", ["scan", "scan", "scan", "scan"]);
  const ocrPage = vi.fn(async () => "PAGE TEXT");
  const onDocumentOcr = vi.fn();

  const pages = await extractPdfPages(path, {
    ocr: { ocrPage, maxPages: 2, onDocumentOcr },
  });

  expect(ocrPage).toHaveBeenCalledTimes(2);
  expect(onDocumentOcr).toHaveBeenCalledWith({ rendered: 2, skipped: 2 });
  // The pages past the budget keep their (empty) text layer rather than
  // vanishing — a truncated document must still have the right page count.
  expect(pages).toHaveLength(4);
  expect(pages[2].text).toBe("");
});

it("reports a document it OCR'd even when nothing was dropped", async () => {
  // The audit trail's only record that this document was sent to a provider —
  // it must not arrive solely as a by-product of hitting the cap.
  const path = await writePdf("certificate.pdf", ["scan"]);
  const onDocumentOcr = vi.fn();

  await extractPdfPages(path, { ocr: { ocrPage: async () => "TEXT", onDocumentOcr } });

  expect(onDocumentOcr).toHaveBeenCalledWith({ rendered: 1, skipped: 0 });
});

it("says nothing about a document with no scanned pages", async () => {
  const path = await writePdf("policy.pdf", [
    "Northwind issues one laptop per employee. ".repeat(20),
  ]);
  const onDocumentOcr = vi.fn();

  await extractPdfPages(path, { ocr: { ocrPage: async () => "x", onDocumentOcr } });

  expect(onDocumentOcr).not.toHaveBeenCalled();
});

it("keeps the page's own text when the vision call comes back empty", async () => {
  // `describePageImage` returns null on a provider error, and a failed OCR
  // must not be indistinguishable from a page that genuinely says nothing.
  const path = await writePdf("certificate.pdf", ["scan"]);
  const ocrPage = vi.fn(async () => null);

  const pages = await extractPdfPages(path, { ocr: { ocrPage } });

  expect(pages[0].text).toBe("");
});

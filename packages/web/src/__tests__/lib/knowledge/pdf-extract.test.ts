/**
 * extractPdfPages against a real (small) PDF generated on the fly with
 * pdfkit (already a web dependency, see lib/audit-pdf.ts), so this stays a
 * true round-trip test of the pdfjs-based extractor without needing a
 * checked-in binary fixture.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PDFDocument from "pdfkit";

import { extractPdfPages } from "@/lib/knowledge/pdf-extract";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-pdf-extract-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function buildPdf(pageTexts: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    for (const text of pageTexts) {
      doc.addPage();
      doc.text(text);
    }
    doc.end();
  });
}

it("extracts per-page text from a real multi-page PDF", async () => {
  const pdfBuffer = await buildPdf([
    "The quick brown fox jumps over the lazy dog.",
    "Second page content for extraction testing.",
  ]);
  const pdfPath = join(tmpRoot, "sample.pdf");
  await writeFile(pdfPath, pdfBuffer);

  const pages = await extractPdfPages(pdfPath);

  expect(pages).toHaveLength(2);
  expect(pages[0].page).toBe(1);
  expect(pages[0].text).toContain("quick brown fox");
  expect(pages[1].page).toBe(2);
  expect(pages[1].text).toContain("Second page content");
});

it("returns an empty-text page for a blank page rather than throwing", async () => {
  const pdfBuffer = await buildPdf([""]);
  const pdfPath = join(tmpRoot, "blank.pdf");
  await writeFile(pdfPath, pdfBuffer);

  const pages = await extractPdfPages(pdfPath);

  expect(pages).toHaveLength(1);
  expect(pages[0].text).toBe("");
});

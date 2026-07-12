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
import { chunkPages } from "@/lib/knowledge/chunk";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-pdf-extract-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function buildPdf(pageTexts: string[], fontSize = 12): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    for (const text of pageTexts) {
      doc.addPage();
      doc.fontSize(fontSize).text(text);
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

// Task4<->Task6 integration guard: the chunker (chunk.ts) finds line
// boundaries by splitting on "\n", so the extractor MUST preserve real line
// breaks. If it collapsed every whitespace run (including newlines) into a
// single space, each page would become one giant line and chunkPages could
// only ever emit a single oversized chunk per page — defeating sub-chunking
// and overlap entirely. A fake extractor that returns pre-split multi-line
// text hides this; only a real PDF round-trip catches it.
it("preserves line breaks so the chunker can sub-chunk a long page", async () => {
  // ~60 distinct lines, each well over the ~4 chars/token heuristic, so the
  // page comfortably exceeds the 512-token (~2048-char) chunk target.
  const lines = Array.from(
    { length: 60 },
    (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog repeatedly.`
  );
  const pageText = lines.join("\n");
  // Small font so all 60 lines fit on a single PDF page (default 12pt
  // overflows to a second page, which isn't what we're testing here).
  const pdfBuffer = await buildPdf([pageText], 7);
  const pdfPath = join(tmpRoot, "long.pdf");
  await writeFile(pdfPath, pdfBuffer);

  const pages = await extractPdfPages(pdfPath);
  expect(pages).toHaveLength(1);

  // (a) extracted page text carries real newlines
  expect(pages[0].text).toContain("\n");
  // spaces/tabs within a line are still collapsed (no double spaces)
  expect(pages[0].text).not.toMatch(/[ \t]{2,}/);

  // (b) feeding the real extracted text to chunkPages yields MORE THAN ONE
  // chunk for the long page, with overlap (consecutive chunks share text).
  const chunks = chunkPages(pages);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.page).toBe(1);
  }
  // Overlap: the tail of chunk[0] reappears at the head of chunk[1].
  const firstTailLine = chunks[0].text.split("\n").at(-1)!;
  expect(chunks[1].text).toContain(firstTailLine);
});

it("returns an empty-text page for a blank page rather than throwing", async () => {
  const pdfBuffer = await buildPdf([""]);
  const pdfPath = join(tmpRoot, "blank.pdf");
  await writeFile(pdfPath, pdfBuffer);

  const pages = await extractPdfPages(pdfPath);

  expect(pages).toHaveLength(1);
  expect(pages[0].text).toBe("");
});

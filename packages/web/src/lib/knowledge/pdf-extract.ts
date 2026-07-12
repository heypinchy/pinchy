/**
 * Production PDF text extractor for the knowledge-base ingest pipeline
 * (ingest.ts's `IngestDeps.extractPdf` default).
 *
 * `packages/plugins/pinchy-files` already has a fuller pdfjs-based
 * extraction pipeline (scan detection, embedded-image extraction, page
 * rendering via @napi-rs/canvas for OCR), but it lives in a sibling plugin
 * package that `packages/web` doesn't depend on — plugins run via `tsx`
 * inside the OpenClaw container, web runs in the Next.js container, and
 * pulling its internals across that boundary would mean depending on a
 * plugin's private module tree (and its canvas/OCR-only deps) from web.
 *
 * KB ingest MVP (design doc §1, "Scope A") only needs the text layer of
 * clean text-PDFs (~87% of the real-world corpus), not scan/OCR handling —
 * that's a later scope. So this is a deliberately minimal, text-only
 * extractor: no canvas factory, no image extraction, no scanned-page
 * rendering.
 */
import { readFile } from "node:fs/promises";

// pdfjs-dist ships a legacy Node build (no worker, no DOM) alongside its
// browser build. Same import path as packages/plugins/pinchy-files/pdf-extract.ts.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface ExtractedPdfPage {
  page: number;
  text: string;
}

/** Extracts per-page text from the PDF at `absPath`. Text-only: no OCR, no image extraction. */
export async function extractPdfPages(absPath: string): Promise<ExtractedPdfPage[]> {
  const buffer = await readFile(absPath);
  const data = new Uint8Array(buffer);

  // `isEvalSupported` isn't in pdfjs-dist's public DocumentInitParameters
  // type but is a documented runtime option (disables eval-based font
  // compilation, which Node has no use for); same cast pinchy-files' own
  // pdf-extract.ts uses for its (larger) options object.
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableFontFace: true,
    useSystemFonts: false,
  } as Record<string, unknown>).promise;

  const pages: ExtractedPdfPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const textContent = await page.getTextContent();
        // Reconstruct line breaks from pdfjs's TextItem.hasEOL. The chunker
        // (chunk.ts) finds line boundaries by splitting on "\n", so page
        // text MUST carry real newlines; collapsing every whitespace run
        // (including EOLs) into a single space would make each page a single
        // giant line and defeat sub-chunking + overlap entirely. We join
        // items with a space, emit "\n" at each end-of-line item, then
        // collapse only runs of spaces/tabs WITHIN a line (never newlines).
        let raw = "";
        for (const item of textContent.items) {
          if (!("str" in item)) continue;
          raw += item.str;
          raw += item.hasEOL ? "\n" : " ";
        }
        const text = raw
          .replace(/[ \t]+/g, " ") // collapse intra-line whitespace only
          .replace(/ *\n */g, "\n") // trim spaces hugging a newline
          .replace(/\n{2,}/g, "\n") // collapse blank lines
          .trim();
        pages.push({ page: i, text });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }

  return pages;
}

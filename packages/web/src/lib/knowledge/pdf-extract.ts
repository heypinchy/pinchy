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
import { getDocument, OPS, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

import { hasSparseText, isScannedPage } from "../../../../plugins/pinchy-files/pdf-scan-rule";
import { renderPageToImage } from "./pdf-render";

export interface ExtractedPdfPage {
  page: number;
  text: string;
}

/**
 * How index-time OCR is performed, injected rather than imported.
 *
 * `ocrPage` is the seam: the ingest decides WHICH pages are scans and what
 * happens to the text, the caller supplies the vision call. That keeps the
 * provider protocol (and its API keys) out of the extractor, and lets the
 * decision be tested without a network stub.
 */
export interface PdfOcrOptions {
  /** Describes a rendered page. Returns null when the vision call failed. */
  ocrPage: (pageImage: Buffer) => Promise<string | null>;
  /**
   * How many pages of ONE document may be rendered. A bound is required: the
   * corpus that motivated this feature contains a 1159-page scan, and without
   * a cap that single document would spend 1159 vision calls at index time.
   *
   * The cap is a policy knob, not a fact about PDFs — raise it for a corpus of
   * long scans. What it must never be is silent, which is what
   * `onBudgetExhausted` is for.
   */
  maxPages?: number;
  /**
   * Called once per document that had scanned pages, with how many were read
   * and how many the cap left behind.
   *
   * This is how the caller learns a document was sent to a provider at all —
   * the fact the audit trail records, and the fact a cap must never drop
   * silently.
   */
  onDocumentOcr?: (stats: { rendered: number; skipped: number }) => void;
}

const DEFAULT_MAX_OCR_PAGES = 200;

/**
 * Whether the page paints an image at all.
 *
 * This is the cheap half of what `pinchy-files` asks: it establishes that
 * something was painted, but never resolves the image objects to measure them.
 * Measuring is what makes the plugin's version expensive, and at index time —
 * whole corpus, nobody waiting — the cheaper reading is the right trade. The
 * shared rule takes it through `imageSizeUnknown`, whose documented meaning is
 * exactly "an image was painted and its size was not established".
 */
async function paintsAnyImage(page: PageWithOperatorList): Promise<boolean> {
  try {
    const ops = await page.getOperatorList();
    const imageOps: number[] = [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
    ];
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (imageOps.includes(ops.fnArray[i])) return true;
    }
    return false;
  } catch {
    // A page whose operator list cannot be read tells us nothing; treating that
    // as "no image" keeps a broken page out of the vision budget rather than
    // spending a call on a render that is likely to fail too.
    return false;
  }
}

type PageWithOperatorList = {
  getOperatorList: () => Promise<{ fnArray: ArrayLike<number> }>;
};

/**
 * Extracts per-page text from the PDF at `absPath`.
 *
 * Without `opts.ocr` this is the text layer and nothing else — the behaviour
 * every install without a configured vision provider gets, where a scan
 * indexes as an empty page rather than failing the document.
 */
export async function extractPdfPages(
  absPath: string,
  opts?: { ocr?: PdfOcrOptions }
): Promise<ExtractedPdfPage[]> {
  const buffer = await readFile(absPath);
  const data = new Uint8Array(buffer);

  // `isEvalSupported` isn't in pdfjs-dist's public DocumentInitParameters
  // type but is a documented runtime option (disables eval-based font
  // compilation, which Node has no use for); same cast pinchy-files' own
  // pdf-extract.ts uses for its (larger) options object.
  // pdfjs 6 removed PDFDocumentProxy.destroy(); the loading task owns teardown.
  const loadingTask = getDocument({
    data,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableFontFace: true,
    useSystemFonts: false,
  } as Record<string, unknown>);
  const doc = await loadingTask.promise;

  const pages: ExtractedPdfPage[] = [];
  const ocr = opts?.ocr;
  const maxOcrPages = ocr?.maxPages ?? DEFAULT_MAX_OCR_PAGES;
  let rendered = 0;
  let skipped = 0;

  /**
   * Returns the text this page should be indexed with: its own, or what a
   * vision model read off a render of it.
   *
   * A failed vision call, a failed render and an exhausted budget all fall
   * back to the page's own text. That is the honest degraded state — an empty
   * scan indexes as an empty page, which #935 surfaces — and never a thrown
   * error, because one unreadable page must not cost the whole document.
   */
  async function ocrIfScanned(page: PDFPageProxy, text: string): Promise<string> {
    if (!ocr || !hasSparseText(text)) return text;

    const imageSizeUnknown = await paintsAnyImage(page as unknown as PageWithOperatorList);
    if (!isScannedPage({ sparseText: true, hasLargeImages: false, imageSizeUnknown })) {
      return text;
    }

    if (rendered >= maxOcrPages) {
      skipped++;
      return text;
    }

    try {
      const image = await renderPageToImage(page);
      rendered++;
      return (await ocr.ocrPage(image)) ?? text;
    } catch {
      return text;
    }
  }

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

        // The OCR decision, and the render, must happen while the page proxy
        // is still alive — `page.cleanup()` in the finally below releases it.
        pages.push({ page: i, text: ocr ? await ocrIfScanned(page, text) : text });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  // Reported whenever this document had any scanned page: `rendered` is what
  // left the building, `skipped` is what the cap dropped — and a cap that
  // drops content silently reads, downstream, exactly like a document that had
  // nothing on those pages.
  if (rendered > 0 || skipped > 0) ocr?.onDocumentOcr?.({ rendered, skipped });

  return pages;
}

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
import {
  getDocument,
  OPS,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { hasSparseText, isScannedPage } from "../../../../plugins/pinchy-files/pdf-scan-rule";
import { renderPageToImage } from "./pdf-render";
import type { HeadingMark } from "./types";

// The mark type lives in the runtime-free contracts module because the ingest
// pipeline carries it through `IngestPage`; re-exported here so a caller of
// this extractor need not know that.
export type { HeadingMark } from "./types";

export interface ExtractedPdfPage {
  page: number;
  text: string;
  /**
   * Where each heading's section begins inside `text`, ascending. Present only
   * when the caller asked for the outline — a PDF's own citations are anchored
   * on its page, and only a converted Word document needs this (#938).
   *
   * A page whose text merely CONTINUES a section carries no mark: the section
   * did not start here, and inventing a mark would say it did. Carrying a
   * heading across the page break is the caller's job.
   */
  headings?: HeadingMark[];
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

/** One line of a page, with the vertical position an outline destination is matched against. */
interface PageLine {
  text: string;
  /** The baseline of the line's first glyph, in PDF user space (y grows upward). Null when nothing positioned it. */
  y: number | null;
}

/** Where one outline entry points, once its destination has been resolved. */
interface OutlineTarget {
  page: number;
  /**
   * The destination's top edge, or null when the destination names no
   * coordinate.
   *
   * Only `/XYZ` carries one, which is what LibreOffice writes for a Word
   * heading — and it is the whole reason a heading can be placed WITHIN a page
   * rather than at the top of it. Every other destination type (`/Fit`, which
   * is what pdfkit emits, and the rest) genuinely means "this page", so null
   * is not a gap to paper over: it is the destination's own answer, and the
   * top of the page is the honest reading of it.
   */
  top: number | null;
  headings: string[];
}

/** The y a destination names, or null when it names none. */
function destinationTop(dest: unknown[]): number | null {
  const type = (dest[1] as { name?: string } | undefined)?.name;
  return type === "XYZ" && typeof dest[3] === "number" ? dest[3] : null;
}

/**
 * The document's outline, flattened to one entry per heading and grouped by
 * the page it points at, in document order.
 *
 * An outline this cannot read is not an error: the document simply has no
 * headings to anchor on, and its chunks carry no locator (locator.ts). That is
 * the normal state of a Word file written without heading styles.
 */
async function readOutline(doc: PDFDocumentProxy): Promise<Map<number, OutlineTarget[]>> {
  const byPage = new Map<number, OutlineTarget[]>();

  let outline: OutlineNode[] | null;
  try {
    // pdfjs types the outline with its own node shape; OutlineNode is the
    // subset this reads, and `dest` is genuinely `string | unknown[] | null`.
    outline = (await doc.getOutline()) as OutlineNode[] | null;
  } catch {
    return byPage;
  }
  if (!outline) return byPage;

  const visit = async (nodes: OutlineNode[], path: string[]): Promise<void> => {
    for (const node of nodes) {
      const title = (node.title ?? "").trim();
      // An untitled entry adds no level rather than an empty one: "§ Quality >
      //  > Zone B" names a section nobody can find.
      const headings = title ? [...path, title] : path;

      if (headings.length > 0) {
        try {
          const dest =
            typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
          if (Array.isArray(dest) && dest.length > 0) {
            const page =
              (await doc.getPageIndex(dest[0] as Parameters<typeof doc.getPageIndex>[0])) + 1;
            const targets = byPage.get(page) ?? [];
            targets.push({ page, top: destinationTop(dest), headings });
            byPage.set(page, targets);
          }
        } catch {
          // A destination that will not resolve costs its own heading and
          // nothing else — the rest of the outline still anchors.
        }
      }

      if (node.items?.length) await visit(node.items, headings);
    }
  };

  await visit(outline, []);
  return byPage;
}

interface OutlineNode {
  title?: string;
  dest?: string | unknown[] | null;
  items?: OutlineNode[];
}

/**
 * Places each of `targets` at the line its heading text occupies, as an offset
 * into the joined page text.
 *
 * Matching is by vertical position rather than by the heading's title, because
 * the title is not reliably a line: it wraps, it may be numbered in the render
 * and not in the bookmark, and a repeated phrase would match the wrong place.
 * The y a destination carries is the document's own answer to the same
 * question.
 */
function markHeadings(lines: PageLine[], targets: OutlineTarget[]): HeadingMark[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.text.length + 1; // + the "\n" that joins it to the next
  }

  const marks: HeadingMark[] = [];
  let floor = 0;

  for (const target of targets) {
    let index = floor;
    const top = target.top;
    if (top !== null) {
      while (index < lines.length) {
        const y = lines[index].y;
        if (y !== null && y <= top) break;
        index++;
      }
    }
    // A destination below every line on its own page should not happen; if it
    // does, the section starts where the previous one ended rather than
    // nowhere.
    if (index >= lines.length) index = floor;
    if (index >= lines.length) break;

    marks.push({ charStart: offsets[index], headings: target.headings });
    floor = index + 1;
  }

  return marks;
}

/**
 * Extracts per-page text from the PDF at `absPath`.
 *
 * Without `opts.ocr` this is the text layer and nothing else — the behaviour
 * every install without a configured vision provider gets, where a scan
 * indexes as an empty page rather than failing the document.
 */
export async function extractPdfPages(
  absPath: string,
  opts?: { ocr?: PdfOcrOptions; outline?: boolean }
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
  const outline = opts?.outline ? await readOutline(doc) : null;
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
        // items with a space, break at each end-of-line item, then collapse
        // runs of spaces/tabs WITHIN a line (never newlines) and drop the
        // lines that hold nothing else.
        //
        // Assembled line by line rather than as one string with a chain of
        // regexes — same output, and it keeps each line's vertical position,
        // which is what an outline destination is matched against below.
        const lines: PageLine[] = [];
        let current = "";
        let currentY: number | null = null;
        const endLine = () => {
          const text = current.replace(/[ \t]+/g, " ").trim();
          if (text) lines.push({ text, y: currentY });
          current = "";
          currentY = null;
        };

        for (const item of textContent.items) {
          if (!("str" in item)) continue;
          if (currentY === null && item.str.trim()) currentY = item.transform?.[5] ?? null;
          current += item.str;
          if (item.hasEOL) endLine();
          else current += " ";
        }
        endLine();

        const text = lines.map((line) => line.text).join("\n");

        // The OCR decision, and the render, must happen while the page proxy
        // is still alive — `page.cleanup()` in the finally below releases it.
        const extracted: ExtractedPdfPage = {
          page: i,
          text: ocr ? await ocrIfScanned(page, text) : text,
        };
        // Offsets into the text as extracted. OCR replaces that text wholesale
        // when it fires, and a scanned page has no outline to speak of, so the
        // marks are attached to the text they were measured against.
        const targets = outline?.get(i);
        if (targets?.length && extracted.text === text) {
          extracted.headings = markHeadings(lines, targets);
        }
        pages.push(extracted);
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

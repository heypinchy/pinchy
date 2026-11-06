/**
 * pdf.js in the browser, behind the smallest surface the citation viewer needs
 * (#1268): open a document, draw one page onto a canvas, and say where each
 * text run on that page landed.
 *
 * The only module that touches pdf.js on the client. Tests replace it, because
 * jsdom has neither a canvas nor workers; what it must get right is checked in
 * a real browser.
 *
 * Choices that matter:
 *
 * - **The legacy build.** pdf.js's modern build drops Safari versions still on
 *   supported iPhones, and iOS is where the browser's own viewer is weakest (an
 *   `<embed>` there shows a static first page and ignores `#page=`).
 * - **Loaded on demand.** ~1 MB of library plus its worker is only worth
 *   fetching once someone opens a citation, never with the chat.
 * - **Range requests, no prefetch.** `disableStream` + `disableAutoFetch` make
 *   pdf.js fetch only the byte ranges the page needs, which the workspace-file
 *   route serves. A 500-page binder costs one page, not the binder.
 */
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";

/** A text run as pdf.js read it, and where it sits on the drawn page, in CSS pixels. */
export interface PdfTextRun {
  str: string;
  rect: { left: number; top: number; width: number; height: number };
}

export interface RenderedPdfPage {
  width: number;
  height: number;
  runs: PdfTextRun[];
}

export interface PdfHandle {
  numPages: number;
  /** Draws `pageNumber` (1-based) into `canvas`, `cssWidth` CSS pixels wide. */
  renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    cssWidth: number
  ): Promise<RenderedPdfPage>;
  destroy(): void;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type Matrix = number[];

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    // `workerSrc`, not a `workerPort` we construct: pdf.js attaches no error
    // handling to a port handed in, so a worker that fails to load (a proxy
    // serving .mjs with the wrong type, a script error) left the document
    // promise pending forever — a spinner, never the fallback. Given a src,
    // pdf.js starts the worker itself, falls back to running in the page if
    // it can't, and gives each document its own worker, terminated with it.
    // `new URL(…, import.meta.url)` is the form the bundler emits as an asset.
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url
    ).href;
    return pdfjs;
  });
  // A failed load (offline, blocked chunk) must not poison every later open.
  pdfjsPromise.catch(() => {
    pdfjsPromise = null;
  });
  return pdfjsPromise;
}

/** What a page change that overtook a render rejects with — the name pdf.js's own cancellation carries. */
function cancelled(): Error {
  const error = new Error("Rendering cancelled: a later page was asked for");
  error.name = "RenderingCancelledException";
  return error;
}

/**
 * The box a text run covers on the drawn page, from the run's transform into
 * viewport space (`tx`) and its advance width in CSS pixels.
 *
 * The run's corners, not its origin plus a width and height: on a page with
 * `/Rotate 90` — common in scanned binders and landscape print-outs — the
 * baseline runs down the screen, and a box drawn rightwards from the origin
 * would cover other lines. Along the baseline is `(tx[0], tx[1])`; the glyphs'
 * up direction is `(tx[2], tx[3])`, whose length is the font size.
 */
export function runRect(
  tx: Matrix,
  widthPx: number
): { left: number; top: number; width: number; height: number } {
  const [a, b, c, d, x, y] = tx;
  const along = Math.hypot(a, b) || 1;
  const dx = (a / along) * widthPx;
  const dy = (b / along) * widthPx;
  const xs = [x, x + dx, x + c, x + dx + c];
  const ys = [y, y + dy, y + d, y + dy + d];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export async function openPdf(url: string): Promise<PdfHandle> {
  const pdfjs = await loadPdfJs();
  const task: PDFDocumentLoadingTask = pdfjs.getDocument({
    url,
    disableStream: true,
    disableAutoFetch: true,
  });
  const doc = await task.promise;
  let current: RenderTask | null = null;
  // Which renderPage call is the latest. pdf.js throws when two renders share
  // a canvas, and `getPage` for a page not yet fetched is a network round
  // trip — so a page change can overtake a call while it waits. The overtaken
  // call must never reach `render`: drawing late, it would paint the old page
  // under the new page's label and highlight.
  let latest = 0;

  return {
    numPages: doc.numPages,
    async renderPage(pageNumber, canvas, cssWidth) {
      const call = ++latest;
      const page = await doc.getPage(pageNumber);
      if (call !== latest) throw cancelled();

      // Cancelling releases the canvas synchronously, so it happens here,
      // right before the next render claims it.
      current?.cancel();
      const viewport = page.getViewport({ scale: cssWidth / page.getViewport({ scale: 1 }).width });

      const ratio = globalThis.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const rendering = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      current = rendering;
      await rendering.promise;
      if (current === rendering) current = null;

      // The same runs, in the same order, that pdf-extract.ts built the
      // index's chunk text from — which is what lets locatePassage match.
      // A page whose text cannot be read is still a page: shown, with
      // nothing to highlight.
      const runs: PdfTextRun[] = [];
      try {
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const tx = pdfjs.Util.transform(viewport.transform, item.transform);
          runs.push({ str: item.str, rect: runRect(tx, item.width * viewport.scale) });
        }
      } catch {
        // runs stays empty
      }
      // pdf.js keeps a drawn page's operator list and decoded images until
      // told otherwise; paging through scans would otherwise pile them up.
      page.cleanup();
      if (call !== latest) throw cancelled();
      return { width: viewport.width, height: viewport.height, runs };
    },
    destroy() {
      current?.cancel();
      void task.destroy();
    },
  };
}

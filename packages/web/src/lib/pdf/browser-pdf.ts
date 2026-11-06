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

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      // `new Worker(new URL(…, import.meta.url))` is the form the bundler
      // recognises and emits as its own asset.
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(
        new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url),
        { type: "module" }
      );
    }
    return pdfjs;
  });
  // A failed load (offline, blocked chunk) must not poison every later open.
  pdfjsPromise.catch(() => {
    pdfjsPromise = null;
  });
  return pdfjsPromise;
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

  return {
    numPages: doc.numPages,
    async renderPage(pageNumber, canvas, cssWidth) {
      current?.cancel();
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: cssWidth / page.getViewport({ scale: 1 }).width });

      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      current = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await current.promise;
      current = null;

      // The same runs, in the same order, that pdf-extract.ts built the
      // index's chunk text from — which is what lets locatePassage match.
      const content = await page.getTextContent();
      const runs: PdfTextRun[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        // Same geometry pdf.js's own text layer uses: the run's transform
        // into viewport space, its font height from the transform's scale.
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(tx[2], tx[3]);
        runs.push({
          str: item.str,
          rect: { left: tx[4], top: tx[5] - height, width: item.width * viewport.scale, height },
        });
      }
      return { width: viewport.width, height: viewport.height, runs };
    },
    destroy() {
      current?.cancel();
      void task.destroy();
    },
  };
}

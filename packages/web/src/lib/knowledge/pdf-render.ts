/**
 * Renders one PDF page to a PNG, for pages the ingest hands to a vision model.
 *
 * This is deliberately a SECOND implementation of what
 * `packages/plugins/pinchy-files/pdf-render.ts` does, and the duplication is
 * forced rather than chosen: a renderer needs real imports (`@napi-rs/canvas`,
 * pdfjs), and a module shared across the plugin boundary must have none —
 * `Dockerfile.pinchy` copies the shared files into the build stage without the
 * plugin's node_modules, so a bare specifier imported from a file under
 * `packages/plugins/` would not resolve there. What must NOT differ — the
 * pixel budget, which decides how much of a page the model actually sees — is
 * imported from the shared rule module instead of restated here.
 */
import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

import { MAX_RENDER_PIXELS } from "../../../../plugins/pinchy-files/pdf-scan-rule";

export async function renderPageToImage(page: PDFPageProxy): Promise<Buffer> {
  const viewport = page.getViewport({ scale: 1.0 });

  const pixels = viewport.width * viewport.height;
  const scale = pixels > MAX_RENDER_PIXELS ? Math.sqrt(MAX_RENDER_PIXELS / pixels) : 1.0;
  const scaledViewport = page.getViewport({ scale });

  const canvas = createCanvas(Math.floor(scaledViewport.width), Math.floor(scaledViewport.height));
  const ctx = canvas.getContext("2d");

  await page.render({
    // pdfjs requires `canvas` in RenderParameters but documents that it must be
    // null when the page should be rendered through `canvasContext` instead —
    // which is our case, so we avoid lying about the canvas type.
    canvas: null as unknown as HTMLCanvasElement,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport: scaledViewport,
  }).promise;

  return canvas.toBuffer("image/png");
}

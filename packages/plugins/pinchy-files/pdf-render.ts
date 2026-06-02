import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PIXELS = 4_000_000; // 4M pixel budget

export async function renderPageToImage(page: PDFPageProxy): Promise<Buffer> {
  const viewport = page.getViewport({ scale: 1.0 });

  const pixels = viewport.width * viewport.height;
  const scale = pixels > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / pixels) : 1.0;
  const scaledViewport = page.getViewport({ scale });

  const width = Math.floor(scaledViewport.width);
  const height = Math.floor(scaledViewport.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  await page.render({
    // We render via @napi-rs/canvas's 2D context, not a DOM canvas. pdfjs
    // requires `canvas` in RenderParameters but documents that it must be
    // null when the page should be rendered through `canvasContext` instead
    // — which is exactly our case, so we avoid lying about the canvas type.
    canvas: null,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport: scaledViewport,
  }).promise;

  return canvas.toBuffer("image/png");
}

import { createCanvas } from "@napi-rs/canvas";

const MAX_PIXELS = 4_000_000; // 4M pixel budget

export async function renderPageToImage(page: {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: unknown;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
}): Promise<Buffer> {
  const viewport = page.getViewport({ scale: 1.0 });

  const pixels = viewport.width * viewport.height;
  const scale = pixels > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / pixels) : 1.0;
  const scaledViewport = page.getViewport({ scale });

  const width = Math.floor(scaledViewport.width);
  const height = Math.floor(scaledViewport.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  await page.render({
    canvasContext: ctx as unknown,
    viewport: scaledViewport,
  }).promise;

  return canvas.toBuffer("image/png");
}

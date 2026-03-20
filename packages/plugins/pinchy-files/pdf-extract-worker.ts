/**
 * Worker thread for PDF extraction. Runs text extraction and page rendering
 * off the main thread so the OpenClaw event loop stays responsive.
 */
import { parentPort, workerData } from "worker_threads";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STANDARD_FONT_DATA_URL = join(__dirname, "node_modules/pdfjs-dist/standard_fonts/");

const PDF_MIN_TEXT_CHARS = 200;
const MAX_PIXELS = 4_000_000;

interface WorkerInput {
  buffer: ArrayBuffer;
  maxPages: number;
}

interface WorkerPage {
  pageNumber: number;
  text: string;
  isScanned: boolean;
  renderedImage: ArrayBuffer | null; // transferred, not copied
}

interface WorkerOutput {
  pages: WorkerPage[];
  totalPages: number;
  truncated: boolean;
}

async function extract(input: WorkerInput): Promise<WorkerOutput> {
  const data = new Uint8Array(input.buffer);

  const doc = await getDocument({
    data,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;

  const totalPages = doc.numPages;
  const pagesToProcess = Math.min(totalPages, input.maxPages);
  const pages: WorkerPage[] = [];
  const transferList: ArrayBuffer[] = [];

  for (let i = 1; i <= pagesToProcess; i++) {
    const page = await doc.getPage(i);

    // Extract text
    const textContent = await page.getTextContent();
    const text = textContent.items
      .filter((item: { str?: string }) => "str" in item)
      .map((item: { str?: string }) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const isScanned = text.length < PDF_MIN_TEXT_CHARS;

    // Render scanned pages to PNG
    let renderedImage: ArrayBuffer | null = null;
    if (isScanned) {
      try {
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

        const pngBuffer = canvas.toBuffer("image/png");
        // Convert to ArrayBuffer for zero-copy transfer
        renderedImage = pngBuffer.buffer.slice(
          pngBuffer.byteOffset,
          pngBuffer.byteOffset + pngBuffer.byteLength,
        );
        transferList.push(renderedImage);
      } catch {
        // Rendering failed — page will show fallback
      }
    }

    pages.push({ pageNumber: i, text, isScanned, renderedImage });
    page.cleanup();
  }

  await doc.destroy();

  // Post result with zero-copy transfer of image buffers
  parentPort!.postMessage(
    { pages, totalPages, truncated: totalPages > input.maxPages } satisfies WorkerOutput,
    transferList,
  );

  return null as never; // unreachable — postMessage handles the response
}

// Entry point
const input = workerData as WorkerInput;
extract(input).catch((err) => {
  parentPort!.postMessage({ error: String(err) });
});

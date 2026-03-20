import { Worker } from "worker_threads";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "pdf-extract-worker.ts");

const DEFAULT_MAX_PAGES = 50;

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  isScanned: boolean;
  embeddedImages: []; // kept for interface compatibility, always empty
  renderedImage?: Buffer;
}

export interface PdfExtractionResult {
  pages: ExtractedPage[];
  totalPages: number;
  truncated: boolean;
}

export interface ExtractOptions {
  maxPages?: number;
}

/**
 * Extract text (and render scanned pages) from a PDF buffer.
 * Runs in a worker thread so the OpenClaw event loop stays responsive.
 */
export async function extractPdfText(
  buffer: Buffer,
  options: ExtractOptions = {},
): Promise<PdfExtractionResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  // Transfer the buffer to the worker (zero-copy)
  const abCopy = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { buffer: abCopy, maxPages },
      transferList: [abCopy],
      // tsx register hook so TypeScript works in the worker
      execArgv: ["--import", "tsx"],
    });

    worker.on("message", (msg) => {
      if (msg.error) {
        reject(new Error(msg.error));
        return;
      }

      // Convert transferred ArrayBuffers back to Buffers
      const pages: ExtractedPage[] = msg.pages.map(
        (p: { pageNumber: number; text: string; isScanned: boolean; renderedImage: ArrayBuffer | null }) => ({
          pageNumber: p.pageNumber,
          text: p.text,
          isScanned: p.isScanned,
          embeddedImages: [],
          renderedImage: p.renderedImage ? Buffer.from(p.renderedImage) : undefined,
        }),
      );

      resolve({
        pages,
        totalPages: msg.totalPages,
        truncated: msg.truncated,
      });
    });

    worker.on("error", (err) => reject(err));
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`PDF extraction worker exited with code ${code}`));
      }
    });
  });
}

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { renderPageToImage } from "./pdf-render";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STANDARD_FONT_DATA_URL = join(__dirname, "node_modules/pdfjs-dist/standard_fonts/");

/** Provide pdfjs-dist with a Canvas factory so it doesn't try to auto-detect one. */
class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(
    canvasAndContext: { canvas: { width: number; height: number }; context: unknown },
    width: number,
    height: number
  ) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: { canvas: unknown }) {
    canvasAndContext.canvas = null as unknown;
  }
}

const PDF_MIN_TEXT_CHARS = 200;
const DEFAULT_MAX_PAGES = 50;

const MIN_IMAGE_DIMENSION = 100;

export interface ExtractedImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  isScanned: boolean;
  embeddedImages: ExtractedImage[];
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

/** Yield to the event loop so other requests aren't starved during CPU-heavy work. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * How long to wait for pdfjs to hand back a decoded image object.
 *
 * `page.objs.get(name, cb)` has no promise and no deadline of its own, and for
 * some image types pdfjs never resolves the entry at all — hence a timeout. But
 * decoding a full-page scan is real work: a 1200x1600 image measured 14.0s on a
 * machine under load ~236, against the 5s this used to allow. Five seconds was
 * therefore not a hang guard, it was a coin flip, and losing it silently changed
 * the extraction result (see isScannedPage).
 */
export const IMAGE_OBJECT_TIMEOUT_MS = 30_000;

/**
 * How much of a page's decode allowance is left after `elapsedMs` of waiting.
 *
 * The timeout above is charged per lookup, so on its own it bounds nothing: a
 * page painting N images pdfjs never answers for waits N x 30s, and raising the
 * per-image allowance from 5s to 30s multiplied that worst case by six. The
 * budget makes the page — not the image — the unit that is bounded.
 *
 * Passing the remainder down rather than giving up on the page keeps cheap
 * images: pdfjs answers synchronously for anything already decoded, so those
 * still resolve even on a zero budget. Only genuine waiting is cut off.
 */
export function remainingImageBudget(
  elapsedMs: number,
  capMs: number = IMAGE_OBJECT_TIMEOUT_MS
): number {
  return Math.max(0, capMs - elapsedMs);
}

type ImageObject = { width: number; height: number; data: Uint8ClampedArray };

/**
 * `timeout` and `unavailable` are deliberately distinct: pdfjs saying "no such
 * image" is evidence, pdfjs not answering in time is the absence of evidence,
 * and the two must not be collapsed into the same `null`.
 */
type ImageLookup =
  { status: "resolved"; image: ImageObject } | { status: "timeout" } | { status: "unavailable" };

export function getImageObject(
  pageObjs: { get: (name: string, callback: (data: unknown) => void) => void },
  name: string,
  timeoutMs: number = IMAGE_OBJECT_TIMEOUT_MS
): Promise<ImageLookup> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Loud on purpose. A dropped measurement changes what the agent is shown,
      // so it must never pass unnoticed — plugin stdout goes to OpenClaw's log.
      console.warn(
        `[pinchy-files] pdf image "${name}" not decoded within ${timeoutMs}ms — ` +
          `treating the page as a scan rather than dropping it`
      );
      resolve({ status: "timeout" });
    }, timeoutMs);
    try {
      pageObjs.get(name, (data: unknown) => {
        clearTimeout(timeout);
        if (
          data &&
          typeof data === "object" &&
          "width" in data &&
          "height" in data &&
          "data" in data
        ) {
          resolve({ status: "resolved", image: data as ImageObject });
        } else {
          resolve({ status: "unavailable" });
        }
      });
    } catch {
      clearTimeout(timeout);
      resolve({ status: "unavailable" });
    }
  });
}

/**
 * Whether a page should be treated as a scan — i.e. rendered to PNG and handed
 * to a vision model instead of being served as its (near-empty) text layer.
 *
 * `imageSizeUnknown` is set only when the page provably painted an image and the
 * size lookup timed out. In that state the page has already shown it is not a
 * plain text page, so the safe reading is "scan": the agent gets a picture it
 * can actually read. The alternative — the behaviour this replaces — was to
 * silently classify it as text and hand over a blank page.
 */
export function isScannedPage(opts: {
  sparseText: boolean;
  hasLargeImages: boolean;
  imageSizeUnknown: boolean;
}): boolean {
  return opts.sparseText && (opts.hasLargeImages || opts.imageSizeUnknown);
}

export async function extractPdfText(
  buffer: Buffer,
  options: ExtractOptions = {}
): Promise<PdfExtractionResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const data = new Uint8Array(buffer);

  const doc = await getDocument({
    data,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    CanvasFactory: NodeCanvasFactory,
  } as Record<string, unknown>).promise;

  const totalPages = doc.numPages;
  const pagesToProcess = Math.min(totalPages, maxPages);
  const pages: ExtractedPage[] = [];

  for (let i = 1; i <= pagesToProcess; i++) {
    const page = await doc.getPage(i);

    // Extract text
    const textContent = await page.getTextContent();
    const text = textContent.items
      .filter((item): item is typeof item & { str: string } => "str" in item)
      .map((item) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const sparseText = text.length < PDF_MIN_TEXT_CHARS;

    // Check if a sparse-text page contains large images (indicating it's a scan,
    // not just a short page like a title page or separator).
    let hasLargeImages = false;
    let imageSizeUnknown = false;
    if (sparseText) {
      try {
        const ops = await page.getOperatorList();
        for (let j = 0; j < ops.fnArray.length; j++) {
          if (ops.fnArray[j] === OPS.paintImageXObject) {
            const imgName = ops.argsArray[j][0] as string;
            const lookup = await getImageObject(page.objs, imgName);
            if (lookup.status === "timeout") {
              // The page painted an image we could not measure. Remember that
              // rather than reading it as "no large image" — see isScannedPage.
              imageSizeUnknown = true;
              break;
            }
            if (
              lookup.status === "resolved" &&
              lookup.image.width >= MIN_IMAGE_DIMENSION &&
              lookup.image.height >= MIN_IMAGE_DIMENSION
            ) {
              hasLargeImages = true;
              break; // One large image is enough to confirm it's a scan
            }
          }
        }
      } catch {
        // If we can't check, assume it's not a scan
      }
    }

    const isScanned = isScannedPage({ sparseText, hasLargeImages, imageSizeUnknown });

    // Extract embedded images (> 100x100px) from non-scanned pages
    const embeddedImages: ExtractedImage[] = [];
    if (!isScanned && !sparseText) {
      // Unlike the classification loop above, this one cannot stop at the first
      // answer — it wants every embedded image — so the per-lookup timeout does
      // not bound it: a page painting N images pdfjs never answers for would
      // wait N x IMAGE_OBJECT_TIMEOUT_MS. One budget for the whole page fixes
      // that without dropping images pdfjs already has decoded, since those come
      // back synchronously even when nothing is left to spend.
      const budgetStartedAt = Date.now();
      try {
        const ops = await page.getOperatorList();
        for (let j = 0; j < ops.fnArray.length; j++) {
          if (ops.fnArray[j] === OPS.paintImageXObject) {
            const imgName = ops.argsArray[j][0] as string;
            try {
              const lookup = await getImageObject(
                page.objs,
                imgName,
                remainingImageBudget(Date.now() - budgetStartedAt)
              );
              const img = lookup.status === "resolved" ? lookup.image : null;
              if (img && img.width >= MIN_IMAGE_DIMENSION && img.height >= MIN_IMAGE_DIMENSION) {
                embeddedImages.push({
                  width: img.width,
                  height: img.height,
                  data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
                });
              }
            } catch {
              // Skip images that can't be extracted
            }
          }
        }
      } catch {
        // Skip image extraction if operator list fails
      }
    }

    // Render scanned pages to PNG while the page proxy is still alive
    let renderedImage: Buffer | undefined;
    if (isScanned) {
      try {
        renderedImage = await renderPageToImage(page);
      } catch {
        // Rendering failed — page will show fallback
      }
    }

    pages.push({ pageNumber: i, text, isScanned, embeddedImages, renderedImage });
    page.cleanup();

    // Yield to event loop between pages so other agents can respond
    await yieldToEventLoop();
  }

  await doc.destroy();
  return { pages, totalPages, truncated: totalPages > maxPages };
}

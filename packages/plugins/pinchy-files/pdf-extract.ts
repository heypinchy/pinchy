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
export type ImageLookup =
  { status: "resolved"; image: ImageObject } | { status: "timeout" } | { status: "unavailable" };

type ImageStore = { get: (name: string, callback: (data: unknown) => void) => void };

/**
 * Deliberately silent about what a timeout MEANS. The two loops below draw
 * opposite conclusions from one — the classifier reads it as evidence of a scan,
 * the embedded-image collector drops the image and keeps the page's text — so a
 * warning from in here can only ever be right for one of them. It used to
 * announce "treating the page as a scan" to the caller that does the opposite.
 * Each loop logs its own outcome instead.
 */
export function getImageObject(
  pageObjs: ImageStore,
  name: string,
  timeoutMs: number = IMAGE_OBJECT_TIMEOUT_MS
): Promise<ImageLookup> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
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

/** The operator list shape both image loops read out of `page.getOperatorList()`. */
type PaintOperatorList = { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown[]> };

/**
 * Both loops below walk one page's paint ops under ONE decode budget.
 *
 * `now` and `lookup` exist so the budget arithmetic is testable in milliseconds
 * instead of only through the slow fixtures; `warn` so each loop's own wording
 * can be asserted. The operator list is a parameter rather than something these
 * functions fetch, which is what keeps `page.getOperatorList()` — seconds of
 * parsing on a heavy page — from being charged to the images' allowance.
 */
interface PageImageOptions {
  budgetMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  lookup?: (objs: ImageStore, name: string, timeoutMs: number) => Promise<ImageLookup>;
}

function isLargeImage(image: ImageObject): boolean {
  return image.width >= MIN_IMAGE_DIMENSION && image.height >= MIN_IMAGE_DIMENSION;
}

/** Every paintImageXObject op on a page, with the image name it paints. */
function paintedImageNames(ops: PaintOperatorList): string[] {
  const names: string[] = [];
  for (let j = 0; j < ops.fnArray.length; j++) {
    if (ops.fnArray[j] === OPS.paintImageXObject) names.push(ops.argsArray[j][0] as string);
  }
  return names;
}

/**
 * Whether a sparse-text page paints a large image — i.e. whether it is a scan.
 *
 * Stops at the first answer that settles it, and shares one page-wide budget
 * across the lookups it needs to get there. Without that budget the per-lookup
 * allowance bounded nothing at page level: a page painting images that each take
 * most of 30s to decode paid the allowance once per image, and this loop runs on
 * every sparse page of a document, up to DEFAULT_MAX_PAGES of them.
 */
export async function classifyPageImages(
  ops: PaintOperatorList,
  pageObjs: ImageStore,
  options: PageImageOptions = {}
): Promise<{ hasLargeImages: boolean; imageSizeUnknown: boolean }> {
  const {
    budgetMs = IMAGE_OBJECT_TIMEOUT_MS,
    now = Date.now,
    warn = console.warn,
    lookup = getImageObject,
  } = options;
  const startedAt = now();

  for (const name of paintedImageNames(ops)) {
    const result = await lookup(pageObjs, name, remainingImageBudget(now() - startedAt, budgetMs));
    if (result.status === "timeout") {
      // Loud on purpose: a dropped measurement changes what the agent is shown,
      // so it must never pass unnoticed. Plugin stdout goes to OpenClaw's log.
      warn(
        `[pinchy-files] pdf image "${name}" not decoded within the page's ${budgetMs}ms ` +
          `budget — treating the page as a scan rather than serving a blank text layer`
      );
      return { hasLargeImages: false, imageSizeUnknown: true };
    }
    if (result.status === "resolved" && isLargeImage(result.image)) {
      return { hasLargeImages: true, imageSizeUnknown: false };
    }
  }

  return { hasLargeImages: false, imageSizeUnknown: false };
}

/**
 * Every large embedded image on a page that is neither sparse nor a scan.
 *
 * Unlike the classifier this cannot stop early — it wants all of them — so the
 * page budget is what bounds it. Handing the remainder down rather than
 * abandoning the page keeps the cheap images: pdfjs answers synchronously for
 * anything already decoded, so those still resolve on a zero budget.
 */
export async function collectEmbeddedImages(
  ops: PaintOperatorList,
  pageObjs: ImageStore,
  options: PageImageOptions = {}
): Promise<ExtractedImage[]> {
  const {
    budgetMs = IMAGE_OBJECT_TIMEOUT_MS,
    now = Date.now,
    warn = console.warn,
    lookup = getImageObject,
  } = options;
  const startedAt = now();
  const images: ExtractedImage[] = [];
  let gaveUp = false;

  for (const name of paintedImageNames(ops)) {
    try {
      const result = await lookup(
        pageObjs,
        name,
        remainingImageBudget(now() - startedAt, budgetMs)
      );
      if (result.status === "timeout") {
        gaveUp = true;
        continue;
      }
      if (result.status === "resolved" && isLargeImage(result.image)) {
        const { width, height, data } = result.image;
        images.push({
          width,
          height,
          data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        });
      }
    } catch {
      // Skip images that can't be extracted
    }
  }

  // Once per page, not once per image: after the budget is spent every remaining
  // lookup times out at once, and a 50-image page would emit 50 identical lines.
  // The wording must not mention a scan — this page is definitively not one.
  if (gaveUp) {
    warn(
      `[pinchy-files] gave up waiting for at least one embedded image after the page's ` +
        `${budgetMs}ms decode budget — the page's text is unaffected, those images are not attached`
    );
  }

  return images;
}

export async function extractPdfText(
  buffer: Buffer,
  options: ExtractOptions = {}
): Promise<PdfExtractionResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const data = new Uint8Array(buffer);

  // pdfjs 6 removed PDFDocumentProxy.destroy(); the loading task owns teardown.
  const loadingTask = getDocument({
    data,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    CanvasFactory: NodeCanvasFactory,
  } as Record<string, unknown>);
  const doc = await loadingTask.promise;

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
        ({ hasLargeImages, imageSizeUnknown } = await classifyPageImages(
          await page.getOperatorList(),
          page.objs
        ));
      } catch {
        // If we can't check, assume it's not a scan
      }
    }

    const isScanned = isScannedPage({ sparseText, hasLargeImages, imageSizeUnknown });

    // Extract embedded images (> 100x100px) from non-scanned pages
    let embeddedImages: ExtractedImage[] = [];
    if (!isScanned && !sparseText) {
      try {
        embeddedImages = await collectEmbeddedImages(await page.getOperatorList(), page.objs);
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

  await loadingTask.destroy();
  return { pages, totalPages, truncated: totalPages > maxPages };
}

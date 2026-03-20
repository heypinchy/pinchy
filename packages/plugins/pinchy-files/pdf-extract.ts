import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { renderPageToImage } from "./pdf-render";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STANDARD_FONT_DATA_URL = join(__dirname, "node_modules/pdfjs-dist/standard_fonts/");

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

function getImageObject(
  pageObjs: { get: (name: string, callback: (data: unknown) => void) => void },
  name: string,
): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  return new Promise((resolve) => {
    try {
      pageObjs.get(name, (data: unknown) => {
        if (
          data &&
          typeof data === "object" &&
          "width" in data &&
          "height" in data &&
          "data" in data
        ) {
          resolve(
            data as {
              width: number;
              height: number;
              data: Uint8ClampedArray;
            },
          );
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

export async function extractPdfText(
  buffer: Buffer,
  options: ExtractOptions = {},
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
  }).promise;

  const totalPages = doc.numPages;
  const pagesToProcess = Math.min(totalPages, maxPages);
  const pages: ExtractedPage[] = [];

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

    // Extract embedded images
    const embeddedImages: ExtractedImage[] = [];
    try {
      const ops = await page.getOperatorList();
      for (let j = 0; j < ops.fnArray.length; j++) {
        if (ops.fnArray[j] === OPS.paintImageXObject) {
          const imgName = ops.argsArray[j][0] as string;
          try {
            const img = await getImageObject(page.objs, imgName);
            if (
              img &&
              img.width >= MIN_IMAGE_DIMENSION &&
              img.height >= MIN_IMAGE_DIMENSION
            ) {
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

    // Render scanned pages to PNG while the page proxy is still alive
    let renderedImage: Buffer | undefined;
    if (isScanned) {
      try {
        renderedImage = await renderPageToImage(page);
      } catch {
        // Rendering failed — page will use fallback in vision processing
      }
    }

    pages.push({ pageNumber: i, text, isScanned, embeddedImages, renderedImage });
    page.cleanup();
  }

  await doc.destroy();
  return { pages, totalPages, truncated: totalPages > maxPages };
}

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ExtractedPage, VisionDescription } from "./pdf-extract";

export type DescribeImageFn = (opts: {
  filePath: string;
  cfg: unknown;
  agentDir: string;
}) => Promise<{ text: string }>;

export async function processVisionPages(
  pages: ExtractedPage[],
  describeImage: DescribeImageFn | null,
  renderPage?: (page: unknown) => Promise<Buffer>,
): Promise<ExtractedPage[]> {
  if (!describeImage) {
    return pages;
  }

  const result: ExtractedPage[] = [];

  for (const page of pages) {
    const needsScannedVision = page.isScanned;
    const hasEmbeddedImages = page.embeddedImages.length > 0;

    if (!needsScannedVision && !hasEmbeddedImages) {
      result.push(page);
      continue;
    }

    const descriptions: VisionDescription[] = [];

    // Process scanned page
    if (needsScannedVision) {
      const desc = await describeScannedPage(
        page,
        describeImage,
        renderPage,
      );
      if (desc) {
        descriptions.push(desc);
      }
    }

    // Process embedded images
    if (hasEmbeddedImages) {
      for (const img of page.embeddedImages) {
        const desc = await describeEmbeddedImage(img.data, describeImage);
        if (desc) {
          descriptions.push(desc);
        }
      }
    }

    if (descriptions.length > 0) {
      result.push({ ...page, visionDescriptions: descriptions });
    } else {
      result.push(page);
    }
  }

  return result;
}

async function describeScannedPage(
  page: ExtractedPage,
  describeImage: DescribeImageFn,
  renderPage?: (page: unknown) => Promise<Buffer>,
): Promise<VisionDescription | null> {
  // Use embedded image data if available, otherwise try rendering the page
  let imageData: Buffer | null = null;
  if (page.embeddedImages.length > 0) {
    imageData = page.embeddedImages[0].data;
  } else if (renderPage) {
    imageData = await renderPage(page).catch(() => null);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "pinchy-pdf-"));
  try {
    const filePath = join(tmpDir, "page.png");
    if (imageData) {
      writeFileSync(filePath, imageData);
    } else {
      // No image data available — write an empty placeholder so describeImage
      // can still attempt OCR / vision analysis on the file path
      writeFileSync(filePath, Buffer.alloc(0));
    }
    const response = await describeImage({
      filePath,
      cfg: {},
      agentDir: "",
    });
    return { type: "scanned_page", description: response.text };
  } catch {
    return null;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function describeEmbeddedImage(
  imageData: Buffer,
  describeImage: DescribeImageFn,
): Promise<VisionDescription | null> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pinchy-pdf-"));
  try {
    const filePath = join(tmpDir, "image.png");
    writeFileSync(filePath, imageData);
    const response = await describeImage({
      filePath,
      cfg: {},
      agentDir: "",
    });
    return { type: "embedded_image", description: response.text };
  } catch {
    return null;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

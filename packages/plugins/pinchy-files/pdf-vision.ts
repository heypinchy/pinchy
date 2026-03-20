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
): Promise<ExtractedPage[]> {
  if (!describeImage) {
    return pages;
  }

  const result: ExtractedPage[] = [];

  for (const page of pages) {
    const hasRenderedImage = page.isScanned && page.renderedImage;
    const hasEmbeddedImages = page.embeddedImages.length > 0;

    if (!hasRenderedImage && !hasEmbeddedImages) {
      result.push(page);
      continue;
    }

    const descriptions: VisionDescription[] = [];

    // Process scanned page using pre-rendered image
    if (hasRenderedImage) {
      const desc = await describeScannedPage(
        page,
        describeImage,
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
): Promise<VisionDescription | null> {
  // Use pre-rendered image from extraction, fall back to first embedded image
  const imageData = page.renderedImage ?? (page.embeddedImages.length > 0 ? page.embeddedImages[0].data : null);
  if (!imageData || imageData.length === 0) {
    return null;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "pinchy-pdf-"));
  try {
    const filePath = join(tmpDir, "page.png");
    writeFileSync(filePath, imageData);
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

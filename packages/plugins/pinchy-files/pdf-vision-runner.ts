/**
 * Vision orchestration for PDF pages: runs vision API calls for every scanned
 * page and every embedded image in parallel, mutates the page objects with
 * extracted text, and returns the aggregated token usage across all calls.
 *
 * Kept in its own module so it can be unit-tested in isolation from
 * pdf-extract/pdf-cache (which require native dependencies).
 */
import { describePageImage, type VisionApiConfig } from "./pdf-vision-api";

export interface VisionRunnerEmbeddedImage {
  data: Buffer;
}

export interface VisionRunnerPage {
  text: string;
  isScanned: boolean;
  renderedImage?: Buffer;
  embeddedImages: VisionRunnerEmbeddedImage[];
}

export interface AggregatedVisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export async function runVisionTasks(
  pages: VisionRunnerPage[],
  visionConfig: VisionApiConfig,
): Promise<AggregatedVisionUsage> {
  let inputTokens = 0;
  let outputTokens = 0;

  const tasks: Promise<void>[] = [];

  for (const page of pages) {
    // Scanned pages: render → vision API → replace text
    if (page.isScanned && page.renderedImage) {
      tasks.push(
        (async () => {
          const imageBase64 = page.renderedImage!.toString("base64");
          page.renderedImage = undefined;
          const visionResult = await describePageImage(imageBase64, visionConfig);
          if (visionResult) {
            page.text = visionResult.text;
            page.isScanned = false;
            inputTokens += visionResult.usage.inputTokens;
            outputTokens += visionResult.usage.outputTokens;
          }
        })(),
      );
    }

    // Embedded images: describe each and append [Figure: ...] to page text
    for (const img of page.embeddedImages) {
      tasks.push(
        (async () => {
          const imageBase64 = img.data.toString("base64");
          const visionResult = await describePageImage(imageBase64, visionConfig);
          if (visionResult) {
            page.text += `\n\n[Figure: ${visionResult.text}]`;
            inputTokens += visionResult.usage.inputTokens;
            outputTokens += visionResult.usage.outputTokens;
          }
        })(),
      );
    }
  }

  if (tasks.length > 0) {
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[pinchy-files] Vision API failed:", result.reason);
      }
    }
  }

  return { inputTokens, outputTokens };
}

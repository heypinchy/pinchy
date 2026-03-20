import { describe, it, expect, vi } from "vitest";
import { processVisionPages } from "./pdf-vision";
import type { ExtractedPage } from "./pdf-extract";

function makePage(overrides: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    pageNumber: overrides.pageNumber ?? 1,
    text: overrides.text ?? "",
    isScanned: overrides.isScanned ?? false,
    embeddedImages: overrides.embeddedImages ?? [],
    ...overrides,
  };
}

describe("processVisionPages", () => {
  it("calls describeImage for scanned pages", async () => {
    const describeImage = vi.fn().mockResolvedValue({
      text: "The document discusses annual revenue of $5M.",
    });

    const pages = [makePage({ isScanned: true })];
    const result = await processVisionPages(pages, describeImage);

    expect(describeImage).toHaveBeenCalledTimes(1);
    expect(result[0].visionDescriptions).toHaveLength(1);
    expect(result[0].visionDescriptions![0].type).toBe("scanned_page");
    expect(result[0].visionDescriptions![0].description).toContain("$5M");
  });

  it("calls describeImage for embedded images", async () => {
    const describeImage = vi.fn().mockResolvedValue({
      text: "A pie chart showing market share.",
    });

    const pages = [
      makePage({
        text: "Some analysis text that is long enough to not be scanned.",
        embeddedImages: [
          { width: 400, height: 300, data: Buffer.from("fake-image-data") },
        ],
      }),
    ];
    const result = await processVisionPages(pages, describeImage);

    expect(describeImage).toHaveBeenCalledTimes(1);
    expect(result[0].visionDescriptions).toHaveLength(1);
    expect(result[0].visionDescriptions![0].type).toBe("embedded_image");
  });

  it("skips vision when describeImage is null", async () => {
    const pages = [makePage({ isScanned: true })];
    const result = await processVisionPages(pages, null);

    expect(result[0].visionDescriptions).toBeUndefined();
  });

  it("handles describeImage errors gracefully", async () => {
    const describeImage = vi.fn().mockRejectedValue(new Error("API error"));

    const pages = [makePage({ isScanned: true })];
    const result = await processVisionPages(pages, describeImage);

    // Should not throw, just skip the vision description
    expect(result[0].visionDescriptions).toBeUndefined();
  });

  it("does not call vision for text-only pages without images", async () => {
    const describeImage = vi.fn();

    const pages = [
      makePage({
        text: "Plenty of text that is well above any threshold for scanning detection.",
        isScanned: false,
      }),
    ];
    const result = await processVisionPages(pages, describeImage);

    expect(describeImage).not.toHaveBeenCalled();
  });
});

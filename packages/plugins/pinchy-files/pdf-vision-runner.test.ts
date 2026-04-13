import { describe, it, expect, vi } from "vitest";
import { runVisionTasks, type VisionRunnerPage } from "./pdf-vision-runner";
import type { VisionApiConfig } from "./pdf-vision-api";

function makeConfig(overrides: Partial<VisionApiConfig> = {}): VisionApiConfig {
  return {
    model: "anthropic/claude-haiku-4-5-20251001",
    resolveApiKey: async () => "test-key",
    ...overrides,
  };
}

describe("runVisionTasks", () => {
  it("returns zero usage when no pages need vision", async () => {
    const pages: VisionRunnerPage[] = [
      { text: "plain text", isScanned: false, embeddedImages: [] },
    ];

    const result = await runVisionTasks(pages, makeConfig());

    expect(result).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("runs vision for each scanned page and aggregates usage", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "scanned page text" }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    });

    const pages: VisionRunnerPage[] = [
      {
        text: "",
        isScanned: true,
        renderedImage: Buffer.from("fake-image-1"),
        embeddedImages: [],
      },
      {
        text: "",
        isScanned: true,
        renderedImage: Buffer.from("fake-image-2"),
        embeddedImages: [],
      },
    ];

    const result = await runVisionTasks(pages, makeConfig());

    expect(result).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect(pages[0]?.text).toBe("scanned page text");
    expect(pages[0]?.isScanned).toBe(false);
    expect(pages[1]?.text).toBe("scanned page text");
    expect(pages[1]?.isScanned).toBe(false);
  });

  it("appends figure descriptions to page text and aggregates usage", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Description of figure A" }],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Description of figure B" }],
          usage: { input_tokens: 60, output_tokens: 15 },
        }),
      });

    const pages: VisionRunnerPage[] = [
      {
        text: "Page with figures.",
        isScanned: false,
        embeddedImages: [
          { data: Buffer.from("img-a") },
          { data: Buffer.from("img-b") },
        ],
      },
    ];

    const result = await runVisionTasks(pages, makeConfig());

    expect(result).toEqual({ inputTokens: 110, outputTokens: 25 });
    expect(pages[0]?.text).toContain("Page with figures.");
    expect(pages[0]?.text).toContain("[Figure: Description of figure A]");
    expect(pages[0]?.text).toContain("[Figure: Description of figure B]");
  });

  it("combines scanned pages and embedded images in a single aggregated total", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    });

    const pages: VisionRunnerPage[] = [
      {
        text: "",
        isScanned: true,
        renderedImage: Buffer.from("scan"),
        embeddedImages: [{ data: Buffer.from("fig") }],
      },
    ];

    const result = await runVisionTasks(pages, makeConfig());

    // 2 vision calls × (10 input, 2 output) = 20 / 4
    expect(result).toEqual({ inputTokens: 20, outputTokens: 4 });
  });

  it("ignores scanned pages without a rendered image", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const pages: VisionRunnerPage[] = [
      { text: "", isScanned: true, embeddedImages: [] },
    ];

    const result = await runVisionTasks(pages, makeConfig());

    expect(result).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats failed vision calls as zero usage without throwing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "error",
    });

    const pages: VisionRunnerPage[] = [
      {
        text: "",
        isScanned: true,
        renderedImage: Buffer.from("scan"),
        embeddedImages: [],
      },
    ];

    const result = await runVisionTasks(pages, makeConfig());

    expect(result).toEqual({ inputTokens: 0, outputTokens: 0 });
    // Scanned flag stays true because vision failed → caller must not cache
    expect(pages[0]?.isScanned).toBe(true);
  });
});

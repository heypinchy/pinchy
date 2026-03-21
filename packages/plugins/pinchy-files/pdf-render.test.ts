import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderPageToImage } from "./pdf-render";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

describe("renderPageToImage", () => {
  it("renders a PDF page to a PNG buffer", async () => {
    const buffer = readFileSync(join(FIXTURES, "text-only.pdf"));
    const data = new Uint8Array(buffer);
    const doc = await getDocument({
      data,
      isEvalSupported: false,
      disableAutoFetch: true,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;

    const page = await doc.getPage(1);
    const pngBuffer = await renderPageToImage(page);

    // PNG magic bytes
    expect(pngBuffer[0]).toBe(0x89);
    expect(pngBuffer[1]).toBe(0x50); // P
    expect(pngBuffer[2]).toBe(0x4e); // N
    expect(pngBuffer[3]).toBe(0x47); // G

    expect(pngBuffer.length).toBeGreaterThan(1000);
    expect(pngBuffer.length).toBeLessThan(5_000_000);

    page.cleanup();
    await doc.destroy();
  });
});

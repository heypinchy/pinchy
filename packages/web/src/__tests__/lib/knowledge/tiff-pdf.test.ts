/**
 * `tiffToPdf`: a scanned TIFF becomes a PDF of one image page per frame, so
 * the scanned-PDF path — index-time OCR, its page budget, its audit tally and
 * its page citations — reads it without a second implementation (#1409).
 *
 * The fixtures are built with sharp on the fly rather than checked in: a real
 * libtiff round trip is the only thing that proves the frames are read from
 * the file and not from its name. The PDF that comes out is read back through
 * pdfjs, the reader the ingest really uses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { OfficeFileRejectedError } from "@/lib/knowledge/office-formats";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";
import { isTiffBytes, tiffToPdf } from "@/lib/knowledge/tiff-pdf";
import { tiffToPdfIsolated } from "@/lib/knowledge/xlsx-isolated";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-tiff-pdf-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function frame(width: number, height: number, grey: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: grey, g: grey, b: grey } },
  })
    .png()
    .toBuffer();
}

/** A multi-page TIFF, one frame per entry, all the same size (sharp's join needs that). */
async function tiff(frames: number, size: { width: number; height: number }): Promise<string> {
  const images = await Promise.all(
    Array.from({ length: frames }, (_, i) => frame(size.width, size.height, 80 + i * 40))
  );
  const bytes =
    frames === 1
      ? await sharp(images[0]).tiff().toBuffer()
      : await sharp(images, { join: { animated: true } })
          .tiff()
          .toBuffer();
  const path = join(tmpRoot, `scan-${frames}.tif`);
  await writeFile(path, bytes);
  return path;
}

async function pdfPageSizes(path: string): Promise<Array<{ width: number; height: number }>> {
  const task = getDocument({ data: new Uint8Array(await readFile(path)) });
  const doc = await task.promise;
  try {
    const sizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const viewport = (await doc.getPage(i)).getViewport({ scale: 1 });
      sizes.push({ width: Math.round(viewport.width), height: Math.round(viewport.height) });
    }
    return sizes;
  } finally {
    await task.destroy();
  }
}

describe("tiffToPdf", () => {
  it("writes one PDF page per frame of a multi-page TIFF", async () => {
    const src = await tiff(2, { width: 300, height: 400 });
    const dest = join(tmpRoot, "out.pdf");

    const result = await tiffToPdf(src, dest, { maxFrames: 200 });

    expect(result).toEqual({ frames: 2, converted: 2 });
    // One point per pixel: pdfjs renders a page at scale 1 for OCR, so the
    // vision model sees the frame at the resolution it was scanned at.
    expect(await pdfPageSizes(dest)).toEqual([
      { width: 300, height: 400 },
      { width: 300, height: 400 },
    ]);
  });

  it("produces pages the scanned-PDF path hands to OCR, one per frame, in order", async () => {
    const src = await tiff(2, { width: 300, height: 400 });
    const dest = join(tmpRoot, "out.pdf");
    await tiffToPdf(src, dest, { maxFrames: 200 });

    let call = 0;
    const pages = await extractPdfPages(dest, {
      ocr: { ocrPage: async () => `Ölwanne Seite ${++call}` },
    });

    expect(pages.map((page) => page.page)).toEqual([1, 2]);
    expect(pages.map((page) => page.text)).toEqual(["Ölwanne Seite 1", "Ölwanne Seite 2"]);
  });

  it("converts at most `maxFrames` frames and says how many the file had", async () => {
    const src = await tiff(3, { width: 50, height: 60 });
    const dest = join(tmpRoot, "out.pdf");

    const result = await tiffToPdf(src, dest, { maxFrames: 2 });

    expect(result).toEqual({ frames: 3, converted: 2 });
    expect(await pdfPageSizes(dest)).toHaveLength(2);
  });

  it("shrinks a frame over the render budget to it, keeping the aspect ratio", async () => {
    const src = await tiff(1, { width: 4000, height: 2000 });
    const dest = join(tmpRoot, "out.pdf");

    await tiffToPdf(src, dest, { maxFrames: 200 });

    const [size] = await pdfPageSizes(dest);
    expect(size.width * size.height).toBeLessThanOrEqual(4_000_000);
    expect(size.width / size.height).toBeCloseTo(2, 1);
  });

  it("converts a bilevel fax-compressed frame, the usual office-scanner output", async () => {
    const src = join(tmpRoot, "fax.tif");
    await writeFile(
      src,
      await sharp(await frame(120, 90, 255))
        .toColourspace("b-w")
        .tiff({ bitdepth: 1, compression: "ccittfax4" })
        .toBuffer()
    );
    const dest = join(tmpRoot, "out.pdf");

    expect(await tiffToPdf(src, dest, { maxFrames: 200 })).toEqual({ frames: 1, converted: 1 });
    expect(await pdfPageSizes(dest)).toEqual([{ width: 120, height: 90 }]);
  });

  it("refuses a file that is not a TIFF, whatever its name says", async () => {
    const src = join(tmpRoot, "fake.tif");
    await writeFile(src, await frame(10, 10, 100));

    const err = await tiffToPdf(src, join(tmpRoot, "out.pdf"), { maxFrames: 200 }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    expect((err as OfficeFileRejectedError).code).toBe("unexpected_content");
  });

  it("refuses an SVG named .tif before any decoder sees it", async () => {
    const src = join(tmpRoot, "drawing.tif");
    await writeFile(
      src,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
    );

    const err = await tiffToPdf(src, join(tmpRoot, "out.pdf"), { maxFrames: 200 }).catch(
      (e: unknown) => e
    );

    expect((err as OfficeFileRejectedError).code).toBe("unexpected_content");
  });

  it("refuses a file over the byte limit without decoding it", async () => {
    const src = await tiff(1, { width: 50, height: 50 });

    const err = await tiffToPdf(src, join(tmpRoot, "out.pdf"), {
      maxFrames: 200,
      maxBytes: 100,
    }).catch((e: unknown) => e);

    expect((err as OfficeFileRejectedError).code).toBe("too_large");
  });

  it("refuses a frame whose pixel count is over the decode limit", async () => {
    const src = await tiff(1, { width: 200, height: 200 });

    const err = await tiffToPdf(src, join(tmpRoot, "out.pdf"), {
      maxFrames: 200,
      maxInputPixels: 10_000,
    }).catch((e: unknown) => e);

    expect((err as OfficeFileRejectedError).code).toBe("too_large");
  });
});

describe("tiffToPdfIsolated: the same conversion, in the fenced child", () => {
  it("converts in the child and answers with the frame counts", async () => {
    const src = await tiff(2, { width: 300, height: 400 });
    const dest = join(tmpRoot, "out.pdf");

    expect(await tiffToPdfIsolated(src, dest, { maxFrames: 200 })).toEqual({
      frames: 2,
      converted: 2,
    });
    expect(await pdfPageSizes(dest)).toHaveLength(2);
  });

  it("carries a refusal across the process boundary as a refusal", async () => {
    const src = join(tmpRoot, "fake.tif");
    await writeFile(src, await frame(10, 10, 100));

    const err = await tiffToPdfIsolated(src, join(tmpRoot, "out.pdf"), { maxFrames: 200 }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    expect((err as OfficeFileRejectedError).code).toBe("unexpected_content");
  });
});

describe("isTiffBytes", () => {
  it.each([
    ["little-endian TIFF", [0x49, 0x49, 0x2a, 0x00]],
    ["big-endian TIFF", [0x4d, 0x4d, 0x00, 0x2a]],
    ["little-endian BigTIFF", [0x49, 0x49, 0x2b, 0x00]],
    ["big-endian BigTIFF", [0x4d, 0x4d, 0x00, 0x2b]],
  ])("recognises a %s header", (_name, bytes) => {
    expect(isTiffBytes(Buffer.from(bytes))).toBe(true);
  });

  it.each([
    ["PNG", [0x89, 0x50, 0x4e, 0x47]],
    ["PDF", [0x25, 0x50, 0x44, 0x46]],
    ["too short", [0x49, 0x49]],
  ])("rejects a %s header", (_name, bytes) => {
    expect(isTiffBytes(Buffer.from(bytes))).toBe(false);
  });
});

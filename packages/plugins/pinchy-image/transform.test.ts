import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { cropImage, resizeImage, rotateImage, convertImage } from "./transform";

// Real-sharp fixtures: synthesize coloured PNG buffers in-memory so tests
// never depend on a checked-in binary.
async function makePng(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  }).png().toBuffer();
}

let basePng: Buffer;
let wideJpeg: Buffer;

beforeAll(async () => {
  basePng = await makePng(200, 100, { r: 200, g: 50, b: 50 });
  wideJpeg = await sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 200, b: 80 } },
  }).jpeg().toBuffer();
});

describe("cropImage", () => {
  it("crops to the requested rectangle and keeps the source format", async () => {
    const out = await cropImage(basePng, { x: 10, y: 10, width: 50, height: 40 });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(40);
    expect(meta.format).toBe("png");
  });

  it("throws when the crop rectangle exceeds the image bounds", async () => {
    await expect(
      cropImage(basePng, { x: 0, y: 0, width: 9999, height: 9999 })
    ).rejects.toThrow();
  });

  it("throws when dimensions are zero or negative", async () => {
    await expect(cropImage(basePng, { x: 0, y: 0, width: 0, height: 10 })).rejects.toThrow();
    await expect(cropImage(basePng, { x: 0, y: 0, width: 10, height: -1 })).rejects.toThrow();
  });
});

describe("resizeImage", () => {
  it("resizes to width only (auto height) preserving aspect ratio", async () => {
    const out = await resizeImage(basePng, { width: 100 });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(50); // 200x100 → 100x50
  });

  it("respects fit=contain", async () => {
    const out = await resizeImage(basePng, { width: 100, height: 100, fit: "contain" });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
  });

  it("throws if neither width nor height is given", async () => {
    await expect(resizeImage(basePng, {})).rejects.toThrow();
  });

  it("rejects an unknown fit mode", async () => {
    await expect(
      // @ts-expect-error invalid fit on purpose
      resizeImage(basePng, { width: 50, fit: "stretch" })
    ).rejects.toThrow();
  });
});

describe("rotateImage", () => {
  it("rotates by 90 degrees and swaps width/height", async () => {
    const out = await rotateImage(basePng, { angle: 90 });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });

  it("normalises angles greater than 360", async () => {
    const out = await rotateImage(basePng, { angle: 450 });
    const meta = await sharp(out).metadata();
    // 450 mod 360 = 90 → dimensions swap
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });
});

describe("convertImage", () => {
  it("converts a PNG to JPEG", async () => {
    const out = await convertImage(basePng, { format: "jpeg" });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("converts a JPEG to WEBP", async () => {
    const out = await convertImage(wideJpeg, { format: "webp" });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
  });

  it("rejects unsupported formats", async () => {
    await expect(
      // @ts-expect-error invalid format on purpose
      convertImage(basePng, { format: "bmp" })
    ).rejects.toThrow();
  });
});

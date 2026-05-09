import { describe, it, expect, vi, beforeEach } from "vitest";
import { compressImageForChat } from "@/lib/image-compression";

vi.mock("browser-image-compression", () => ({
  default: vi.fn(),
}));

import imageCompression from "browser-image-compression";
const mockedImageCompression = vi.mocked(imageCompression);

const makeFile = (bytes: number, mime: string, name = "image"): File => {
  return new File([new Uint8Array(bytes)], `${name}.${mime.split("/")[1]}`, { type: mime });
};

describe("compressImageForChat — skip path", () => {
  beforeEach(() => {
    mockedImageCompression.mockReset();
  });

  it("returns the original file unchanged when JPEG is already < 500 KB", async () => {
    const small = makeFile(400 * 1024, "image/jpeg");
    const out = await compressImageForChat(small);
    expect(out).toBe(small);
    expect(mockedImageCompression).not.toHaveBeenCalled();
  });

  it("returns the original file unchanged when WebP is already < 500 KB", async () => {
    const small = makeFile(400 * 1024, "image/webp");
    const out = await compressImageForChat(small);
    expect(out).toBe(small);
    expect(mockedImageCompression).not.toHaveBeenCalled();
  });

  it("does NOT skip small PNGs — they are recompressed because PNG → WebP gains are large", async () => {
    const compressed = makeFile(50 * 1024, "image/webp", "compressed");
    mockedImageCompression.mockResolvedValueOnce(compressed);
    const smallPng = makeFile(400 * 1024, "image/png");
    const out = await compressImageForChat(smallPng);
    expect(mockedImageCompression).toHaveBeenCalledOnce();
    expect(out).toBe(compressed);
  });
});

describe("compressImageForChat — compression path", () => {
  beforeEach(() => {
    mockedImageCompression.mockReset();
  });

  it("calls browser-image-compression with WebP at the configured target size for a large JPEG", async () => {
    const large = makeFile(5 * 1024 * 1024, "image/jpeg");
    const compressed = makeFile(800 * 1024, "image/webp", "compressed");
    mockedImageCompression.mockResolvedValueOnce(compressed);

    const out = await compressImageForChat(large);

    expect(mockedImageCompression).toHaveBeenCalledOnce();
    const [fileArg, options] = mockedImageCompression.mock.calls[0];
    expect(fileArg).toBe(large);
    expect(options).toMatchObject({
      fileType: "image/webp",
      maxWidthOrHeight: 2560,
      initialQuality: 0.85,
      useWebWorker: true,
    });
    expect(options!.maxSizeMB).toBeCloseTo(1_900_000 / (1024 * 1024), 2);
    expect(out).toBe(compressed);
  });

  it("returns the original file when the compression library throws (e.g. HEIC, corrupt input)", async () => {
    const heic = makeFile(3 * 1024 * 1024, "image/heic");
    mockedImageCompression.mockRejectedValueOnce(new Error("Unable to decode HEIC"));

    const out = await compressImageForChat(heic);

    expect(out).toBe(heic);
    expect(mockedImageCompression).toHaveBeenCalledOnce();
  });
});

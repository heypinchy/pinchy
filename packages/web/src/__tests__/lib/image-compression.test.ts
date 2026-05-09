import { describe, it, expect, vi, beforeEach } from "vitest";
import { compressImageForChat } from "@/lib/image-compression";
import { CLIENT_IMAGE_COMPRESSION_TARGET_BYTES } from "@/lib/limits";

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

  it("returns ok=true with skipped=true when JPEG is already < 500 KB", async () => {
    const small = makeFile(400 * 1024, "image/jpeg");
    const result = await compressImageForChat(small);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file).toBe(small);
      expect(result.skipped).toBe(true);
    }
    expect(mockedImageCompression).not.toHaveBeenCalled();
  });

  it("returns ok=true with skipped=true when WebP is already < 500 KB", async () => {
    const small = makeFile(400 * 1024, "image/webp");
    const result = await compressImageForChat(small);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file).toBe(small);
      expect(result.skipped).toBe(true);
    }
    expect(mockedImageCompression).not.toHaveBeenCalled();
  });

  it("does NOT skip small PNGs — they are recompressed because PNG → WebP gains are large", async () => {
    const compressed = makeFile(50 * 1024, "image/webp", "compressed");
    mockedImageCompression.mockResolvedValueOnce(compressed);
    const smallPng = makeFile(400 * 1024, "image/png");
    const result = await compressImageForChat(smallPng);
    expect(mockedImageCompression).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file).toBe(compressed);
      expect(result.skipped).toBe(false);
    }
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

    const result = await compressImageForChat(large);

    expect(mockedImageCompression).toHaveBeenCalledOnce();
    const [fileArg, options] = mockedImageCompression.mock.calls[0];
    expect(fileArg).toBe(large);
    expect(options).toMatchObject({
      fileType: "image/webp",
      maxWidthOrHeight: 2560,
      initialQuality: 0.85,
      useWebWorker: true,
    });
    expect(options!.maxSizeMB).toBeCloseTo(
      CLIENT_IMAGE_COMPRESSION_TARGET_BYTES / (1024 * 1024),
      2
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file).toBe(compressed);
      expect(result.skipped).toBe(false);
    }
  });

  it("returns ok=false with reason='compression-failed' when the library throws (HEIC, corrupt input)", async () => {
    const heic = makeFile(3 * 1024 * 1024, "image/heic");
    const decodeError = new Error("Unable to decode HEIC");
    mockedImageCompression.mockRejectedValueOnce(decodeError);

    const result = await compressImageForChat(heic);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Original file is still returned so the caller can decide what to do.
      expect(result.file).toBe(heic);
      expect(result.reason).toBe("compression-failed");
      expect(result.error).toBe(decodeError);
    }
    expect(mockedImageCompression).toHaveBeenCalledOnce();
  });

  it("logs a warning when compression fails so production logs surface the fallback", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const heic = makeFile(3 * 1024 * 1024, "image/heic");
      const decodeError = new Error("Unable to decode HEIC");
      mockedImageCompression.mockRejectedValueOnce(decodeError);

      await compressImageForChat(heic);

      expect(warnSpy).toHaveBeenCalledOnce();
      const [message, err] = warnSpy.mock.calls[0];
      // Message must mention the module so log filters can find it.
      expect(String(message)).toMatch(/image-compression/i);
      // The actual error must be passed through for debugging.
      expect(err).toBe(decodeError);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

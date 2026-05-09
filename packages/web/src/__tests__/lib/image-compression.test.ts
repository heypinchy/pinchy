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

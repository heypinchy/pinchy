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

/**
 * Mimics what `browser-image-compression@2.0.2` actually returns.
 *
 * Its internal `canvasToFile()` never calls `new File(...)` — it constructs a
 * Blob and monkey-patches `name`/`lastModified` on as plain properties:
 *
 *     l = new Blob([h], {type: r}); l.name = i; l.lastModified = o;
 *
 * Reading `.name` therefore works, which is why the composer chip showed the
 * right filename — but `FormData.append()` ignores it and labels any non-File
 * Blob `"blob"` on the wire. The library's types claim `File`, so this cast
 * reproduces the same lie TypeScript is told at the real call site.
 */
const makeLibraryOutput = (bytes: number, mime: string, name: string): File => {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  Object.assign(blob, { name, lastModified: 0 });
  return blob as File;
};

/** The filename a multipart body would carry for `file` — "blob" for a bare Blob. */
const multipartFilename = (file: File): string => {
  const form = new FormData();
  form.append("file", file);
  return (form.get("file") as File).name;
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
    mockedImageCompression.mockResolvedValueOnce(makeLibraryOutput(50 * 1024, "image/webp", "x"));
    const smallPng = makeFile(400 * 1024, "image/png");
    const result = await compressImageForChat(smallPng);
    expect(mockedImageCompression).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.size).toBe(50 * 1024);
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
    mockedImageCompression.mockResolvedValueOnce(makeLibraryOutput(800 * 1024, "image/webp", "x"));

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
      expect(result.file.size).toBe(800 * 1024);
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

  it("returns a real File, not the library's monkey-patched Blob", async () => {
    // The Blob browser-image-compression hands back carries a readable `.name`,
    // so asserting on `.name` alone would pass against the broken version. Only
    // `instanceof File` catches it — and only a real File keeps its name once
    // FormData encodes it into the multipart body.
    mockedImageCompression.mockResolvedValueOnce(makeLibraryOutput(80 * 1024, "image/webp", "x"));

    const result = await compressImageForChat(makeFile(2 * 1024 * 1024, "image/png", "screenshot"));

    expect(result.ok).toBe(true);
    expect(result.file).toBeInstanceOf(File);
  });

  it("keeps the original basename on the wire instead of uploading it as 'blob'", async () => {
    mockedImageCompression.mockResolvedValueOnce(makeLibraryOutput(80 * 1024, "image/webp", "x"));

    const result = await compressImageForChat(
      makeFile(2 * 1024 * 1024, "image/png", "quarterly-chart")
    );

    // What uploadAttachment's `formData.append("file", file)` actually sends —
    // and what therefore lands in the agent workspace under uploads/.
    expect(multipartFilename(result.file)).toBe("quarterly-chart.webp");
  });

  it("renames the extension to .webp because compression converts the bytes to WebP", async () => {
    // Leaving `screenshot.png` on WebP bytes would put a lying extension in the
    // agent's workspace. Serving is unaffected (the GET route sniffs magic
    // bytes), but tools that read the workspace file go by its name.
    mockedImageCompression.mockResolvedValueOnce(makeLibraryOutput(80 * 1024, "image/webp", "x"));

    const result = await compressImageForChat(makeFile(2 * 1024 * 1024, "image/png", "screenshot"));

    expect(result.file.name).toBe("screenshot.webp");
    expect(result.file.type).toBe("image/webp");
  });

  it("appends .webp rather than clobbering dots inside an extensionless name", async () => {
    mockedImageCompression.mockResolvedValueOnce(makeLibraryOutput(80 * 1024, "image/webp", "x"));

    const noExt = new File([new Uint8Array(2 * 1024 * 1024)], "v1.2 mockup", { type: "image/png" });
    const result = await compressImageForChat(noExt);

    expect(result.file.name).toBe("v1.2 mockup.webp");
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

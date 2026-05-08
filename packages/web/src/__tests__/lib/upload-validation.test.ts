import { describe, it, expect } from "vitest";
import { sanitizeFilename, validateUploadBuffer } from "@/lib/upload-validation";

describe("sanitizeFilename", () => {
  it("returns clean basename for normal filenames", () => {
    expect(sanitizeFilename("invoice.pdf")).toBe("invoice.pdf");
    expect(sanitizeFilename("My Photo.jpg")).toBe("My Photo.jpg");
    expect(sanitizeFilename("recording-2026-05-08.m4a")).toBe("recording-2026-05-08.m4a");
  });

  it("strips path separators", () => {
    expect(sanitizeFilename("foo/bar.pdf")).toBe("bar.pdf");
    expect(sanitizeFilename("foo\\bar.pdf")).toBe("bar.pdf");
    expect(sanitizeFilename("/absolute/path.pdf")).toBe("path.pdf");
  });

  it("rejects path-traversal attempts", () => {
    expect(() => sanitizeFilename("../etc/passwd")).toThrow(/invalid/i);
    expect(() => sanitizeFilename("..")).toThrow(/invalid/i);
    expect(() => sanitizeFilename("./foo.pdf")).toThrow(/invalid/i);
  });

  it("rejects NUL bytes and control chars", () => {
    expect(() => sanitizeFilename("foo\0.pdf")).toThrow(/invalid/i);
    expect(() => sanitizeFilename("foo\x01.pdf")).toThrow(/invalid/i);
  });

  it("rejects empty or whitespace-only names", () => {
    expect(() => sanitizeFilename("")).toThrow(/invalid/i);
    expect(() => sanitizeFilename("   ")).toThrow(/invalid/i);
    expect(() => sanitizeFilename("/")).toThrow(/invalid/i);
  });

  it("caps length at 255 chars", () => {
    const long = "a".repeat(300) + ".pdf";
    expect(() => sanitizeFilename(long)).toThrow(/too long/i);
  });

  it("allows legitimate filenames with dots (not path traversal)", () => {
    expect(sanitizeFilename("version 2..3 notes.pdf")).toBe("version 2..3 notes.pdf");
    expect(sanitizeFilename("a..b.pdf")).toBe("a..b.pdf");
  });

  it("rejects BiDi override and invisible Unicode control characters", () => {
    expect(() => sanitizeFilename("foo‮.pdf")).toThrow(/invalid/i); // RIGHT-TO-LEFT OVERRIDE
    expect(() => sanitizeFilename("foo​.pdf")).toThrow(/invalid/i); // ZERO-WIDTH SPACE
    expect(() => sanitizeFilename("foo‏.pdf")).toThrow(/invalid/i); // RIGHT-TO-LEFT MARK
    expect(() => sanitizeFilename("﻿file.pdf")).toThrow(/invalid/i); // BOM
  });
});

// Minimal valid file headers for magic-number detection
const PDF_HEADER = Buffer.concat([Buffer.from("%PDF-1.4\n", "binary"), Buffer.alloc(64, 0)]);
// PNG requires signature + IHDR chunk for file-type detection
const PNG_HEADER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
  Buffer.from([0x00, 0x00, 0x00, 0x0d]), // IHDR length (13)
  Buffer.from("IHDR"), // chunk type
  Buffer.alloc(13, 0), // IHDR data (width/height/etc)
  Buffer.alloc(4, 0), // CRC
  Buffer.alloc(64, 0), // padding
]);
const JPEG_HEADER = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(512, 0),
]);

describe("validateUploadBuffer", () => {
  it("accepts a valid PDF with matching claimed MIME", async () => {
    await expect(validateUploadBuffer(PDF_HEADER, "application/pdf")).resolves.toBe(
      "application/pdf"
    );
  });

  it("accepts a valid PNG", async () => {
    await expect(validateUploadBuffer(PNG_HEADER, "image/png")).resolves.toBe("image/png");
  });

  it("accepts a valid JPEG", async () => {
    await expect(validateUploadBuffer(JPEG_HEADER, "image/jpeg")).resolves.toBe("image/jpeg");
  });

  it("rejects when claimed MIME does not match content", async () => {
    await expect(validateUploadBuffer(PNG_HEADER, "application/pdf")).rejects.toThrow(/mismatch/i);
  });

  it("rejects unknown content", async () => {
    const garbage = Buffer.alloc(64, 0x42);
    await expect(validateUploadBuffer(garbage, "application/pdf")).rejects.toThrow(
      /unable to detect/i
    );
  });

  it("rejects MIME types outside the whitelist", async () => {
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0)]);
    await expect(validateUploadBuffer(exe, "application/x-msdownload")).rejects.toThrow(
      /not supported/i
    );
  });
});

import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  validateUploadBuffer,
  ALLOWED_ATTACHMENT_MIMES,
} from "@/lib/upload-validation";

describe("sanitizeFilename", () => {
  it("returns clean basename for normal filenames", () => {
    expect(sanitizeFilename("invoice.pdf")).toBe("invoice.pdf");
    expect(sanitizeFilename("My Photo.jpg")).toBe("My Photo.jpg");
    expect(sanitizeFilename("notes 2026-05-08.pdf")).toBe("notes 2026-05-08.pdf");
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

  // Backticks would close the markdown code span the agent reads in the
  // attachment block, opening a prompt-injection trick path. Double quotes
  // would break the quoted form of the Content-Disposition header emitted by
  // the uploads route (RFC 6266). Both are vanishingly rare in real filenames
  // — rejecting them at the trust boundary eliminates two whole classes of
  // downstream escaping bugs.
  it("rejects backticks (prompt-injection guard for markdown code spans)", () => {
    expect(() => sanitizeFilename("invoice`.pdf")).toThrow(/invalid/i);
    expect(() => sanitizeFilename("`evil.pdf")).toThrow(/invalid/i);
  });

  it("rejects double quotes (Content-Disposition quoted-string guard)", () => {
    expect(() => sanitizeFilename('evil"; filename="trojan.exe.pdf')).toThrow(/invalid/i);
    expect(() => sanitizeFilename('foo".pdf')).toThrow(/invalid/i);
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

  it("ALLOWED_ATTACHMENT_MIMES contains the required types", () => {
    expect(ALLOWED_ATTACHMENT_MIMES.has("application/pdf")).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIMES.has("image/jpeg")).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIMES.has("image/png")).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIMES.has("image/webp")).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIMES.has("image/gif")).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIMES.has("image/heic")).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIMES.has("image/heif")).toBe(true);
  });

  // Audio is intentionally NOT in the whitelist yet — see #321 for the
  // follow-up that wires real transcription. Until then, accepting audio
  // would persist files the agent has no way to read.
  it("does not accept audio MIME types (tracked in #321)", () => {
    expect(ALLOWED_ATTACHMENT_MIMES.has("audio/mpeg")).toBe(false);
    expect(ALLOWED_ATTACHMENT_MIMES.has("audio/mp4")).toBe(false);
    expect(ALLOWED_ATTACHMENT_MIMES.has("audio/x-m4a")).toBe(false);
    expect(ALLOWED_ATTACHMENT_MIMES.has("audio/wav")).toBe(false);
    expect(ALLOWED_ATTACHMENT_MIMES.has("audio/webm")).toBe(false);
    expect(ALLOWED_ATTACHMENT_MIMES.has("audio/ogg")).toBe(false);
    expect(ALLOWED_ATTACHMENT_MIMES.has("audio/flac")).toBe(false);
  });

  it("rejects audio uploads with the same 'not supported' error as any other unknown type", async () => {
    // Minimal valid M4A ftyp box — file-type detects it as audio/x-m4a
    const M4A_HEADER = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x1c]),
      Buffer.from("ftyp"),
      Buffer.from("M4A "),
      Buffer.from([0x00, 0x00, 0x02, 0x00]),
      Buffer.from("M4A "),
      Buffer.from("mp42"),
      Buffer.from("isom"),
      Buffer.alloc(32, 0),
    ]);
    await expect(validateUploadBuffer(M4A_HEADER, "audio/x-m4a")).rejects.toThrow(/not supported/i);
  });
});

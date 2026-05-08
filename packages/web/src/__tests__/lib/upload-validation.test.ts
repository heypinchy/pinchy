import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "@/lib/upload-validation";

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

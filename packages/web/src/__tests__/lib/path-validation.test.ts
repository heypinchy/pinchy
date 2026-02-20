import { describe, it, expect } from "vitest";
import { validateAllowedPaths, sanitizePath } from "@/lib/path-validation";

describe("sanitizePath", () => {
  it("should reject paths with null bytes", () => {
    expect(() => sanitizePath("/data/docs\0/file.md")).toThrow("Invalid path");
  });

  it("should reject paths not starting with /data/", () => {
    expect(() => sanitizePath("/etc/passwd")).toThrow("must be under /data/");
  });

  it("should reject paths with .. traversal", () => {
    expect(() => sanitizePath("/data/../etc/passwd")).toThrow("must be under /data/");
  });

  it("should accept valid paths under /data/", () => {
    expect(sanitizePath("/data/documents/")).toBe("/data/documents/");
  });

  it("should normalize trailing slashes", () => {
    expect(sanitizePath("/data/documents")).toBe("/data/documents/");
  });
});

describe("validateAllowedPaths", () => {
  it("should reject empty array", () => {
    expect(() => validateAllowedPaths([])).toThrow("At least one directory");
  });

  it("should reject non-array input", () => {
    expect(() => validateAllowedPaths("not-array" as unknown as string[])).toThrow();
  });

  it("should reject paths not under /data/", () => {
    expect(() => validateAllowedPaths(["/etc/shadow"])).toThrow("must be under /data/");
  });

  it("should accept valid paths", () => {
    const result = validateAllowedPaths(["/data/docs/", "/data/policies/"]);
    expect(result).toEqual(["/data/docs/", "/data/policies/"]);
  });
});

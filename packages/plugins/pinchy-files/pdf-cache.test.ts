import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PdfCache } from "./pdf-cache";

describe("PdfCache", () => {
  let cacheDir: string;
  let cache: PdfCache;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "pinchy-cache-test-"));
    cache = new PdfCache(cacheDir);
  });

  afterEach(() => {
    cache.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("does not expose a get() method", () => {
    expect((cache as any).get).toBeUndefined();
  });

  it("stores and retrieves cached content via getFast", () => {
    const content = "<document>test</document>";
    cache.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", content);
    const result = cache.getFast("/data/docs/report.pdf", 1024, 1700000000);
    expect(result).toBe(content);
  });

  it("falls back to content hash when mtime changes", () => {
    cache.set(
      "/data/docs/report.pdf",
      1024,
      1700000000,
      "abc123",
      "cached content",
    );
    // getFast misses because mtime differs
    expect(cache.getFast("/data/docs/report.pdf", 1024, 1800000000)).toBeNull();
    // getByHash succeeds because content hash matches
    const result = cache.getByHash("/data/docs/report.pdf", "abc123");
    expect(result).toBe("cached content");
    // After updating mtime, getFast succeeds with new mtime
    cache.updateMtime("/data/docs/report.pdf", 1800000000);
    expect(cache.getFast("/data/docs/report.pdf", 1024, 1800000000)).toBe("cached content");
  });

  it("overwrites existing entries on set", () => {
    cache.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "version 1");
    cache.set("/data/docs/report.pdf", 2048, 1800000000, "def456", "version 2");
    const result = cache.getFast("/data/docs/report.pdf", 2048, 1800000000);
    expect(result).toBe("version 2");
  });

  it("invalidates when format version changes", () => {
    const cacheV1 = new PdfCache(cacheDir, { formatVersion: 1 });
    cacheV1.set(
      "/data/docs/report.pdf",
      1024,
      1700000000,
      "abc123",
      "v1 format",
    );
    cacheV1.close();

    const cacheV2 = new PdfCache(cacheDir, { formatVersion: 2 });
    const result = cacheV2.getFast("/data/docs/report.pdf", 1024, 1700000000);
    expect(result).toBeNull();
    cacheV2.close();
  });

  it("expires entries after TTL", () => {
    let now = 1700000000000;
    const cacheWithClock = new PdfCache(cacheDir, { now: () => now });

    cacheWithClock.set(
      "/data/docs/report.pdf",
      1024,
      1700000000,
      "abc123",
      "content",
    );

    // Advance clock past TTL (7 days = 604800000ms)
    now += 604800001;
    const result = cacheWithClock.getFast("/data/docs/report.pdf", 1024, 1700000000);
    expect(result).toBeNull();
    cacheWithClock.close();
  });

  describe("getFast", () => {
    it("returns content when size and mtime match", () => {
      cache.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "cached content");
      const result = cache.getFast("/data/docs/report.pdf", 1024, 1700000000);
      expect(result).toBe("cached content");
    });

    it("returns null when mtime differs", () => {
      cache.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "cached content");
      const result = cache.getFast("/data/docs/report.pdf", 1024, 1800000000);
      expect(result).toBeNull();
    });

    it("returns null when size differs", () => {
      cache.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "cached content");
      const result = cache.getFast("/data/docs/report.pdf", 2048, 1700000000);
      expect(result).toBeNull();
    });

    it("returns null for uncached files", () => {
      const result = cache.getFast("/data/docs/nonexistent.pdf", 1024, 1700000000);
      expect(result).toBeNull();
    });

    it("returns null for expired entries", () => {
      let now = 1700000000000;
      const cacheWithClock = new PdfCache(cacheDir, { now: () => now });
      cacheWithClock.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "content");

      now += 604800001; // past TTL
      const result = cacheWithClock.getFast("/data/docs/report.pdf", 1024, 1700000000);
      expect(result).toBeNull();
      cacheWithClock.close();
    });
  });

  describe("getByHash", () => {
    it("returns content when hash matches", () => {
      cache.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "cached content");
      const result = cache.getByHash("/data/docs/report.pdf", "abc123");
      expect(result).toBe("cached content");
    });

    it("returns null when hash differs", () => {
      cache.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "cached content");
      const result = cache.getByHash("/data/docs/report.pdf", "def456");
      expect(result).toBeNull();
    });

    it("returns null for uncached files", () => {
      const result = cache.getByHash("/data/docs/nonexistent.pdf", "abc123");
      expect(result).toBeNull();
    });

    it("returns null for expired entries", () => {
      let now = 1700000000000;
      const cacheWithClock = new PdfCache(cacheDir, { now: () => now });
      cacheWithClock.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "content");

      now += 604800001;
      const result = cacheWithClock.getByHash("/data/docs/report.pdf", "abc123");
      expect(result).toBeNull();
      cacheWithClock.close();
    });
  });

  describe("updateMtime", () => {
    it("updates the stored mtime so getFast returns content with new mtime", () => {
      cache.set("/data/docs/report.pdf", 1024, 1700000000, "abc123", "cached content");

      // mtime changed — getFast should miss
      expect(cache.getFast("/data/docs/report.pdf", 1024, 1800000000)).toBeNull();

      // Update mtime
      cache.updateMtime("/data/docs/report.pdf", 1800000000);

      // Now getFast should hit with the new mtime
      expect(cache.getFast("/data/docs/report.pdf", 1024, 1800000000)).toBe("cached content");
    });
  });
});

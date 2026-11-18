import { describe, it, expect } from "vitest";
import {
  ifNoneMatchHits,
  rangeAllowedByIfRange,
  servePosture,
  sessionScopedRevalidateHeaders,
  weakFileEtag,
  weakStoredFileEtag,
} from "@/lib/session-scoped-cache";

const STAT = {
  size: 1234,
  mtimeMs: 1_700_000_000_123.456,
  ctimeMs: 1_700_000_500_456.789,
  ino: 42,
};

describe("sessionScopedRevalidateHeaders", () => {
  it("keeps the copy but requires revalidation, per session", () => {
    expect(sessionScopedRevalidateHeaders('W/"x"')).toEqual({
      "cache-control": "private, no-cache",
      vary: "Cookie",
      etag: 'W/"x"',
    });
  });
});

describe("weakFileEtag", () => {
  it("is a weak, quoted validator", () => {
    expect(weakFileEtag(STAT, "original")).toMatch(/^W\/"[a-z0-9-]+"$/);
  });

  it("changes with ctime, which a copy tool carrying mtime over cannot preserve", () => {
    // `rsync -a --inplace` keeps size, mtime and inode of a corrected
    // same-length document; only ctime moves. Without it the browser would be
    // told 304 and keep the old edition.
    const base = weakFileEtag(STAT, "original");
    expect(weakFileEtag({ ...STAT, ctimeMs: STAT.ctimeMs + 1 }, "original")).not.toBe(base);
  });

  it("changes with size, mtime, inode and representation", () => {
    const base = weakFileEtag(STAT, "original");
    expect(weakFileEtag({ ...STAT, size: 1235 }, "original")).not.toBe(base);
    expect(weakFileEtag({ ...STAT, mtimeMs: STAT.mtimeMs + 1 }, "original")).not.toBe(base);
    expect(weakFileEtag({ ...STAT, ino: 43 }, "original")).not.toBe(base);
    expect(weakFileEtag(STAT, "converted")).not.toBe(base);
  });
});

describe("ifNoneMatchHits", () => {
  const etag = weakFileEtag(STAT, "original");
  const strong = etag.replace(/^W\//, "");

  it("misses without a header", () => {
    expect(ifNoneMatchHits(null, etag)).toBe(false);
    expect(ifNoneMatchHits("", etag)).toBe(false);
  });

  it("matches weakly, in a list, and on a wildcard", () => {
    expect(ifNoneMatchHits(etag, etag)).toBe(true);
    expect(ifNoneMatchHits(strong, etag)).toBe(true);
    expect(ifNoneMatchHits(`"a", W/"b" , ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchHits("*", etag)).toBe(true);
  });

  it("misses a different validator", () => {
    expect(ifNoneMatchHits(weakFileEtag(STAT, "converted"), etag)).toBe(false);
    expect(ifNoneMatchHits('W/"other"', etag)).toBe(false);
  });
});

describe("rangeAllowedByIfRange", () => {
  it("honours a range only when no If-Range asks for a strong match it cannot get", () => {
    expect(rangeAllowedByIfRange(null)).toBe(true);
    expect(rangeAllowedByIfRange('W/"x"')).toBe(false);
    expect(rangeAllowedByIfRange("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(false);
  });
});

describe("weakStoredFileEtag", () => {
  it("ignores timestamps, which the store moves on every read", () => {
    // The signature takes none; this pins that a touched artifact keeps its tag.
    const touched = { ...STAT, mtimeMs: STAT.mtimeMs + 1000, ctimeMs: STAT.ctimeMs + 1000 };
    expect(weakStoredFileEtag(touched, "/store/v1/ab/abc.pdf", "converted")).toBe(
      weakStoredFileEtag(STAT, "/store/v1/ab/abc.pdf", "converted")
    );
  });

  it("changes with the stored content's path, size and inode", () => {
    const base = weakStoredFileEtag(STAT, "/store/v1/ab/abc.pdf", "converted");
    expect(weakStoredFileEtag(STAT, "/store/v1/cd/cde.pdf", "converted")).not.toBe(base);
    expect(weakStoredFileEtag({ ...STAT, size: 1 }, "/store/v1/ab/abc.pdf", "converted")).not.toBe(
      base
    );
    expect(weakStoredFileEtag({ ...STAT, ino: 7 }, "/store/v1/ab/abc.pdf", "converted")).not.toBe(
      base
    );
  });

  it("never matches a file validator", () => {
    expect(weakStoredFileEtag(STAT, "/store/v1/ab/abc.pdf", "converted")).not.toBe(
      weakFileEtag(STAT, "converted")
    );
  });
});

describe("servePosture", () => {
  // A 304 keeps the headers the browser stored with its copy, so a validator
  // that ignored how the bytes are served would pin an old content type or
  // disposition forever once a release tightens them.
  it("is a short tag that changes with every serving header it is given", () => {
    const base = servePosture("application/pdf", "inline");
    expect(base).toMatch(/^[a-z0-9]{8,}$/);
    expect(servePosture("application/pdf", "attachment")).not.toBe(base);
    expect(servePosture("text/plain", "inline")).not.toBe(base);
    expect(servePosture("application/pdf", "inline")).toBe(base);
  });
});

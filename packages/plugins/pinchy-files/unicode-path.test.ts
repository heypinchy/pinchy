import { describe, it, expect } from "vitest";
import { resolveOnDiskPath } from "./index";

// The `ä` in these paths is built from explicit escapes so the source file's own
// encoding can't collapse the two forms into one.
const NFD = "/ws/uploads/Absch" + "a\u0308" + "tzung.pdf"; // "a" + U+0308 (decomposed)
const NFC = "/ws/uploads/Absch" + "\u00e4" + "tzung.pdf"; //  U+00E4       (composed)

describe("resolveOnDiskPath (NFC/NFD filename fallback)", () => {
  it("resolves an NFC request path to the NFD file that exists on disk (Linux-style FS)", () => {
    // Linux filesystems don't fold Unicode: only the exact NFD bytes exist.
    // The agent's model handed us the composed (NFC) form.
    expect(NFC).not.toBe(NFD); // sanity: genuinely different byte sequences
    const exists = (p: string) => p === NFD;
    expect(resolveOnDiskPath(NFC, exists)).toBe(NFD);
  });

  it("resolves an NFD request path to an NFC file when only the composed form exists", () => {
    const exists = (p: string) => p === NFC;
    expect(resolveOnDiskPath(NFD, exists)).toBe(NFC);
  });

  it("returns the path unchanged when it already exists as given", () => {
    const p = "/ws/uploads/plain-ascii.pdf";
    expect(resolveOnDiskPath(p, () => true)).toBe(p);
  });

  it("returns the original path when no normalization form exists (caller then ENOENTs normally)", () => {
    const p = "/ws/uploads/missing.pdf";
    expect(resolveOnDiskPath(p, () => false)).toBe(p);
  });
});

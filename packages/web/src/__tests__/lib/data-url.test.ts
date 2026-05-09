import { describe, it, expect } from "vitest";
import { dataUrlToFile, fileToDataUrl } from "@/lib/data-url";

describe("dataUrlToFile + fileToDataUrl — round-trip correctness", () => {
  it("round-trips a small JPEG data URL byte-for-byte", async () => {
    // "abc" base64-encoded → "YWJj"
    const original = "data:image/jpeg;base64,YWJj";
    const file = dataUrlToFile(original);
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(3);
    const out = await fileToDataUrl(file);
    expect(out).toBe(original);
  });

  it("round-trips a buffer larger than the chunk size without corrupting bytes", async () => {
    // The chunked implementation processes bytes in 8 KB pages. Use 32 KB to
    // exercise multiple chunks AND a final partial chunk in one round-trip.
    const totalBytes = 32 * 1024 + 17;
    const bytes = new Uint8Array(totalBytes);
    // Fill with a deterministic pattern so a botched chunk boundary is visible.
    for (let i = 0; i < totalBytes; i++) {
      bytes[i] = i % 256;
    }
    const file = new File([bytes], "big.bin", { type: "application/octet-stream" });

    const dataUrl = await fileToDataUrl(file);
    const roundTripped = dataUrlToFile(dataUrl);

    expect(roundTripped.size).toBe(totalBytes);
    const out = new Uint8Array(await roundTripped.arrayBuffer());
    expect(out.length).toBe(totalBytes);
    for (let i = 0; i < totalBytes; i++) {
      if (out[i] !== bytes[i]) {
        throw new Error(`byte mismatch at index ${i}: got ${out[i]} expected ${bytes[i]}`);
      }
    }
  });

  it("handles bytes spanning the full 0–255 range (no UTF-16 confusion)", async () => {
    // String.fromCharCode is byte-safe for 0–255, but the chunked variant must
    // not introduce surrogate-pair issues. Test all 256 byte values explicitly.
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const file = new File([bytes], "all-bytes.bin", { type: "application/octet-stream" });

    const dataUrl = await fileToDataUrl(file);
    const roundTripped = dataUrlToFile(dataUrl);

    const out = new Uint8Array(await roundTripped.arrayBuffer());
    expect(out.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(out[i]).toBe(i);
    }
  });

  it("falls back to 'bin' extension when MIME has no slash", () => {
    // Defensive: if a malformed data URL slips through, we don't crash and the
    // file gets a sensible extension.
    const file = dataUrlToFile("data:weird;base64,YWJj");
    expect(file.name).toBe("attachment.bin");
    expect(file.type).toBe("weird");
  });
});

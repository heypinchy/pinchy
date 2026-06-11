// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  readDeclaredDocxSize,
  assertDocxDecompressedSizeWithinLimit,
  MAX_DOCX_DECOMPRESSED_BYTES,
} from "./docx-zip-guard";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

/**
 * Build a structurally valid ZIP buffer by hand so tests can control the
 * DECLARED uncompressed size independently of the actual payload. A zip bomb
 * declares its (huge) uncompressed size truthfully — the guard must reject it
 * from the central directory alone, without inflating anything.
 */
function buildZip(
  entries: Array<{
    name: string;
    data: Buffer;
    declaredUncompressedSize?: number;
  }>,
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const compressed = deflateRawSync(entry.data);
    const uncompressedSize =
      entry.declaredUncompressedSize ?? entry.data.length;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(8, 8); // compression: deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(8, 10); // compression: deflate
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);

    localParts.push(local, compressed);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end-of-central-directory signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset

  return Buffer.concat([...localParts, centralDir, eocd]);
}

describe("readDeclaredDocxSize", () => {
  it("sums the declared uncompressed sizes from the central directory", () => {
    const zip = buildZip([
      { name: "word/document.xml", data: Buffer.alloc(1000, 0x41) },
      { name: "word/styles.xml", data: Buffer.alloc(500, 0x42) },
    ]);
    expect(readDeclaredDocxSize(zip).totalUncompressedBytes).toBe(1500);
  });

  it("reads the declared size of a real .docx fixture", () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const { totalUncompressedBytes } = readDeclaredDocxSize(buffer);
    expect(totalUncompressedBytes).toBeGreaterThan(0);
    expect(totalUncompressedBytes).toBeLessThan(MAX_DOCX_DECOMPRESSED_BYTES);
  });

  it("throws a clear error when the buffer has no central directory", () => {
    const notZip = Buffer.from("this is not a zip archive", "utf-8");
    expect(() => readDeclaredDocxSize(notZip)).toThrow(/not a valid \.docx/i);
  });

  it("throws when the central directory lies outside the buffer", () => {
    const zip = buildZip([
      { name: "word/document.xml", data: Buffer.alloc(100) },
    ]);
    // Corrupt the EOCD's central-directory offset to point past the end.
    zip.writeUInt32LE(zip.length + 1000, zip.length - 22 + 16);
    expect(() => readDeclaredDocxSize(zip)).toThrow(/not a valid \.docx/i);
  });
});

describe("assertDocxDecompressedSizeWithinLimit", () => {
  it("accepts an archive whose declared size is within the limit", () => {
    const zip = buildZip([
      { name: "word/document.xml", data: Buffer.alloc(1000) },
    ]);
    expect(() => assertDocxDecompressedSizeWithinLimit(zip)).not.toThrow();
  });

  it("rejects a zip bomb that declares a decompressed size above the limit", () => {
    // Tiny compressed payload, honestly-declared huge decompressed size —
    // the classic high-ratio bomb shape. Must be rejected without inflating.
    const zip = buildZip([
      {
        name: "word/document.xml",
        data: Buffer.alloc(1024),
        declaredUncompressedSize: 0xfffffffe, // ~4 GB, below the ZIP64 marker
      },
    ]);
    expect(() => assertDocxDecompressedSizeWithinLimit(zip)).toThrow(
      /decompressed size .* exceeds/i,
    );
  });

  it("rejects when many small entries sum past the limit", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      name: `word/part${i}.xml`,
      data: Buffer.alloc(64),
      declaredUncompressedSize: 30 * 1024 * 1024, // 20 × 30 MB = 600 MB
    }));
    expect(() =>
      assertDocxDecompressedSizeWithinLimit(buildZip(entries)),
    ).toThrow(/decompressed size .* exceeds/i);
  });

  it("rejects ZIP64 size markers fail-closed", () => {
    // 0xFFFFFFFF means "real size is in the ZIP64 extra field". No mainstream
    // DOCX writer emits ZIP64; treat it as over-limit rather than trusting it.
    const zip = buildZip([
      {
        name: "word/document.xml",
        data: Buffer.alloc(64),
        declaredUncompressedSize: 0xffffffff,
      },
    ]);
    expect(() => assertDocxDecompressedSizeWithinLimit(zip)).toThrow(
      /decompressed size|ZIP64/i,
    );
  });

  it("allows a declared size exactly at the limit and rejects one byte over", () => {
    const zip = buildZip([
      {
        name: "word/document.xml",
        data: Buffer.alloc(64),
        declaredUncompressedSize: 1000,
      },
    ]);
    expect(() => assertDocxDecompressedSizeWithinLimit(zip, 1000)).not.toThrow();
    expect(() => assertDocxDecompressedSizeWithinLimit(zip, 999)).toThrow(
      /decompressed size .* exceeds/i,
    );
  });

  it("honors a custom limit", () => {
    const zip = buildZip([
      { name: "word/document.xml", data: Buffer.alloc(2000) },
    ]);
    expect(() => assertDocxDecompressedSizeWithinLimit(zip, 1000)).toThrow(
      /decompressed size .* exceeds/i,
    );
    expect(() =>
      assertDocxDecompressedSizeWithinLimit(zip, 4000),
    ).not.toThrow();
  });
});

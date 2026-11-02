// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from "node:zlib";
import {
  readDeclaredDocxSize,
  assertDocxDecompressedSizeWithinLimit,
  MAX_DOCX_DECOMPRESSED_BYTES,
  readZipEntries,
  assertZipWithinLimits,
  verifiedZipCopy,
  ZipFormatError,
  ZipLimitError,
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
  }>
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const compressed = deflateRawSync(entry.data);
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;

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
    const zip = buildZip([{ name: "word/document.xml", data: Buffer.alloc(100) }]);
    // Corrupt the EOCD's central-directory offset to point past the end.
    zip.writeUInt32LE(zip.length + 1000, zip.length - 22 + 16);
    expect(() => readDeclaredDocxSize(zip)).toThrow(/not a valid \.docx/i);
  });
});

describe("assertDocxDecompressedSizeWithinLimit", () => {
  it("accepts an archive whose declared size is within the limit", () => {
    const zip = buildZip([{ name: "word/document.xml", data: Buffer.alloc(1000) }]);
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
      /decompressed size .* exceeds/i
    );
  });

  it("rejects when many small entries sum past the limit", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      name: `word/part${i}.xml`,
      data: Buffer.alloc(64),
      declaredUncompressedSize: 30 * 1024 * 1024, // 20 × 30 MB = 600 MB
    }));
    expect(() => assertDocxDecompressedSizeWithinLimit(buildZip(entries))).toThrow(
      /decompressed size .* exceeds/i
    );
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
    expect(() => assertDocxDecompressedSizeWithinLimit(zip)).toThrow(/decompressed size|ZIP64/i);
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
      /decompressed size .* exceeds/i
    );
  });

  it("honors a custom limit", () => {
    const zip = buildZip([{ name: "word/document.xml", data: Buffer.alloc(2000) }]);
    expect(() => assertDocxDecompressedSizeWithinLimit(zip, 1000)).toThrow(
      /decompressed size .* exceeds/i
    );
    expect(() => assertDocxDecompressedSizeWithinLimit(zip, 4000)).not.toThrow();
  });
});

// The same guard now also fronts the knowledge-base's Office readers (exceljs,
// mammoth, LibreOffice), which read .xlsx/.pptx too — so the generic entry
// points below carry no ".docx" in their wording and add a ratio rule that a
// bare size ceiling cannot express.
describe("readZipEntries", () => {
  it("lists every entry with its name, method, sizes and local-header offset", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: Buffer.alloc(100, 0x41) },
      { name: "word/_rels/document.xml.rels", data: Buffer.alloc(40, 0x42) },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "[Content_Types].xml",
      "word/_rels/document.xml.rels",
    ]);
    expect(entries[0]).toMatchObject({ method: 8, uncompressedSize: 100, localHeaderOffset: 0 });
    expect(entries[1].localHeaderOffset).toBeGreaterThan(0);
    expect(entries[1].uncompressedSize).toBe(40);
  });

  it("throws a generic (not .docx-specific) error on a buffer that is not a zip", () => {
    expect(() => readZipEntries(Buffer.from("not a zip"))).toThrow(/not a valid zip archive/i);
  });
});

describe("assertZipWithinLimits", () => {
  it("accepts an ordinary archive", () => {
    const zip = buildZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(5000, 0x41) }]);
    expect(() =>
      assertZipWithinLimits(zip, { maxDecompressedBytes: 1_000_000, maxCompressionRatio: 100 })
    ).not.toThrow();
  });

  it("rejects an archive whose declared total exceeds the ceiling, without inflating it", () => {
    const zip = buildZip([
      {
        name: "xl/worksheets/sheet1.xml",
        data: Buffer.alloc(64),
        declaredUncompressedSize: 2_000_000,
      },
    ]);
    expect(() => assertZipWithinLimits(zip, { maxDecompressedBytes: 1_000_000 })).toThrow(
      /decompressed size .* exceeds/i
    );
  });

  it("rejects a high-ratio archive that stays UNDER the ceiling", () => {
    // 20 MB declared from a few dozen compressed bytes is far past anything an
    // office writer produces (XML deflates ~10-20:1), yet under a 256 MB
    // ceiling — the shape a ceiling alone waves through.
    const zip = buildZip([
      {
        name: "xl/worksheets/sheet1.xml",
        data: Buffer.alloc(64),
        declaredUncompressedSize: 20_000_000,
      },
    ]);
    expect(() =>
      assertZipWithinLimits(zip, {
        maxDecompressedBytes: 256 * 1024 * 1024,
        maxCompressionRatio: 200,
        ratioFloorBytes: 16 * 1024 * 1024,
      })
    ).toThrow(/compression ratio/i);
  });

  it("does not apply the ratio rule to small archives", () => {
    // A 100 KB sheet of repeated cells legitimately deflates 1000:1.
    const zip = buildZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(100_000, 0x41) }]);
    expect(() =>
      assertZipWithinLimits(zip, {
        maxDecompressedBytes: 256 * 1024 * 1024,
        maxCompressionRatio: 50,
        ratioFloorBytes: 16 * 1024 * 1024,
      })
    ).not.toThrow();
  });

  it("fails closed on ZIP64 size markers", () => {
    const zip = buildZip([
      { name: "a.xml", data: Buffer.alloc(64), declaredUncompressedSize: 0xffffffff },
    ]);
    expect(() => assertZipWithinLimits(zip, { maxDecompressedBytes: 1_000_000 })).toThrow(
      /decompressed size|ZIP64/i
    );
  });

  it("tells a limit violation (ZipLimitError) from a corrupt archive (plain Error)", () => {
    // A caller that lets its reader diagnose corruption must not do the same
    // for a bomb: the reader is what the limit protects.
    const big = buildZip([
      { name: "a.xml", data: Buffer.alloc(64), declaredUncompressedSize: 5000 },
    ]);
    expect(() => assertZipWithinLimits(big, { maxDecompressedBytes: 1000 })).toThrow(ZipLimitError);
    const zip64 = buildZip([
      { name: "a.xml", data: Buffer.alloc(64), declaredUncompressedSize: 0xffffffff },
    ]);
    // The marker value itself exceeds any sane ceiling, so this is a limit too.
    expect(() => assertZipWithinLimits(zip64, { maxDecompressedBytes: 1000 })).toThrow(
      ZipLimitError
    );
    let corrupt: unknown;
    try {
      assertZipWithinLimits(Buffer.from("not a zip at all, sorry"), { maxDecompressedBytes: 1000 });
    } catch (err) {
      corrupt = err;
    }
    expect(corrupt).toBeInstanceOf(Error);
    expect(corrupt).not.toBeInstanceOf(ZipLimitError);
  });

  it("throws the generic invalid-archive error on a non-zip", () => {
    expect(() =>
      assertZipWithinLimits(Buffer.from("MZ not a zip"), { maxDecompressedBytes: 1000 })
    ).toThrow(/not a valid zip archive/i);
  });
});

// ---------------------------------------------------------------------------
// verifiedZipCopy — real sizes, not declared ones (release review v0.10.0)
// ---------------------------------------------------------------------------

/** One raw-deflate stream that inflates to `head` + `spaceBytes` spaces + `tail`, built in O(1 MiB) memory. */
function deflatedSpaces(head: string, spaceBytes: number, tail: string): Buffer {
  const MiB = 1024 * 1024;
  // Independent SYNC_FLUSH chunks concatenate into one valid raw stream: each
  // ends on a byte boundary with a non-final block, and only the last is final.
  const flush = { finishFlush: zlibConstants.Z_SYNC_FLUSH };
  const megabyte = deflateRawSync(Buffer.alloc(MiB, 0x20), flush);
  const pieces = [deflateRawSync(Buffer.from(head), flush)];
  for (let left = spaceBytes; left > 0; left -= MiB) {
    pieces.push(left >= MiB ? megabyte : deflateRawSync(Buffer.alloc(left, 0x20), flush));
  }
  pieces.push(deflateRawSync(Buffer.from(tail)));
  return Buffer.concat(pieces);
}

interface RawEntry {
  name: string;
  /** Exactly the bytes to store as the entry's data. */
  data: Buffer;
  method?: number;
  flags?: number;
  crc32?: number;
  compressedSize?: number;
  uncompressedSize: number;
}

/** A zip written field by field, so every lie a hostile archive can tell is expressible. */
function rawZip(entries: RawEntry[], opts: { listed?: (index: number) => boolean } = {}): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  entries.forEach((entry, index) => {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt16LE(entry.method ?? 8, 8);
    header.writeUInt32LE(entry.crc32 ?? 0, 14);
    header.writeUInt32LE(entry.compressedSize ?? entry.data.length, 18);
    header.writeUInt32LE(entry.uncompressedSize, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);

    if (opts.listed?.(index) ?? true) {
      const record = Buffer.alloc(46 + name.length);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(entry.flags ?? 0, 8);
      record.writeUInt16LE(entry.method ?? 8, 10);
      record.writeUInt32LE(entry.crc32 ?? 0, 16);
      record.writeUInt32LE(entry.compressedSize ?? entry.data.length, 20);
      record.writeUInt32LE(entry.uncompressedSize, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(offset, 42);
      name.copy(record, 46);
      central.push(record);
    }
    local.push(header, entry.data);
    offset += header.length + entry.data.length;
  });
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, eocd]);
}

/** A truthful deflated entry: real sizes and a real CRC. */
function honest(name: string, content: string | Buffer): RawEntry {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return { name, data: deflateRawSync(bytes), crc32: crcOf(bytes), uncompressedSize: bytes.length };
}

function crcOf(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** name -> inflated bytes, read independently of the code under test. */
function contentsOf(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const entry of readZipEntries(zip)) {
    const at = entry.localHeaderOffset;
    const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
    const data = zip.subarray(start, start + entry.compressedSize);
    out.set(entry.name, entry.method === 0 ? Buffer.from(data) : inflateRawSync(data));
  }
  return out;
}

const LIMITS = { maxDecompressedBytes: 500 * 1024 * 1024 };

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected verifiedZipCopy to refuse the archive, but it resolved");
}

describe("verifiedZipCopy", () => {
  it.each(["simple.docx", "with-image.docx"])(
    "copies a real %s with every part intact, as a fresh archive",
    async (fixture) => {
      const original = readFileSync(join(FIXTURES, fixture));
      const copy = await verifiedZipCopy(original, LIMITS);
      expect(copy).not.toBe(original);
      const before = contentsOf(original);
      const after = contentsOf(copy);
      expect([...after.keys()]).toEqual([...before.keys()]);
      for (const [name, bytes] of before) expect(after.get(name)!.equals(bytes), name).toBe(true);
    }
  );

  it("refuses an entry that inflates past the size it declares, and stops inflating at the declared size", async () => {
    // The central directory says 1000 bytes; the stream holds 256 MiB. Readers
    // that trust the declared size (JSZip, so exceljs and mammoth) inflate all
    // of it before they notice — the declared-size check cannot see it at all.
    const data = deflatedSpaces("<w:document>", 256 * 1024 * 1024, "</w:document>");
    const zip = rawZip([
      honest("[Content_Types].xml", "<Types/>"),
      {
        name: "word/document.xml",
        data,
        uncompressedSize: 1000,
      },
    ]);
    expect(() => assertZipWithinLimits(zip, LIMITS)).not.toThrow();

    const before = process.memoryUsage().arrayBuffers;
    const started = Date.now();
    const err = await refusal(verifiedZipCopy(zip, LIMITS));
    expect(err).toBeInstanceOf(ZipLimitError);
    expect(err.message).toMatch(/word\/document\.xml/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  });

  it("refuses an entry that inflates to less than it declares", async () => {
    const entry = honest("word/document.xml", "<w:document/>");
    const zip = rawZip([{ ...entry, uncompressedSize: entry.uncompressedSize + 10 }]);
    expect(await refusal(verifiedZipCopy(zip, LIMITS))).toBeInstanceOf(ZipFormatError);
  });

  it("refuses an entry whose content does not match its CRC", async () => {
    const entry = honest("word/document.xml", "<w:document/>");
    const zip = rawZip([{ ...entry, crc32: (entry.crc32! ^ 1) >>> 0 }]);
    expect(await refusal(verifiedZipCopy(zip, LIMITS))).toBeInstanceOf(ZipFormatError);
  });

  it("refuses an archive with junk in front of it, which lenient readers still open", async () => {
    // JSZip shifts every offset by the prefix and loads it anyway; the
    // central directory's own offsets no longer point at the entries.
    const zip = rawZip([honest("[Content_Types].xml", "<Types/>")]);
    const prefixed = Buffer.concat([Buffer.alloc(64, 0x41), zip]);
    expect(await refusal(verifiedZipCopy(prefixed, LIMITS))).toBeInstanceOf(ZipFormatError);
  });

  it("refuses bytes trailing the end-of-central-directory record", async () => {
    const zip = rawZip([honest("[Content_Types].xml", "<Types/>")]);
    const trailed = Buffer.concat([zip, Buffer.from("trailing")]);
    expect(await refusal(verifiedZipCopy(trailed, LIMITS))).toBeInstanceOf(ZipFormatError);
  });

  it("refuses an encrypted entry and an unsupported compression method", async () => {
    const entry = honest("word/document.xml", "<w:document/>");
    expect(
      await refusal(verifiedZipCopy(rawZip([{ ...entry, flags: 0x0001 }]), LIMITS))
    ).toBeInstanceOf(ZipFormatError);
    expect(
      await refusal(verifiedZipCopy(rawZip([{ ...entry, method: 12 }]), LIMITS))
    ).toBeInstanceOf(ZipFormatError);
  });

  it("refuses a stored entry whose two sizes disagree", async () => {
    const bytes = Buffer.from("<w:document/>");
    const zip = rawZip([
      {
        name: "word/document.xml",
        data: bytes,
        method: 0,
        crc32: crcOf(bytes),
        uncompressedSize: 5,
      },
    ]);
    expect(await refusal(verifiedZipCopy(zip, LIMITS))).toBeInstanceOf(ZipFormatError);
  });

  it("refuses two entries whose names differ only by case", async () => {
    // Part names are case-insensitive in OOXML: which one a reader picks is
    // the reader's choice, not ours.
    const zip = rawZip([
      honest("word/document.xml", "<w:document/>"),
      honest("Word/Document.xml", "<w:document/>"),
    ]);
    expect(await refusal(verifiedZipCopy(zip, LIMITS))).toBeInstanceOf(ZipFormatError);
  });

  it("does not carry bytes the central directory does not list", async () => {
    // A local entry no central record points at is invisible to the check —
    // so it must be invisible to every reader too.
    const hidden = Buffer.from("SMUGGLED-PAYLOAD");
    const zip = rawZip(
      [
        {
          name: "word/afchunk.htm",
          data: hidden,
          method: 0,
          crc32: crcOf(hidden),
          uncompressedSize: hidden.length,
        },
        honest("[Content_Types].xml", "<Types/>"),
      ],
      { listed: (index) => index === 1 }
    );
    const copy = await verifiedZipCopy(zip, LIMITS);
    expect(copy.includes(hidden)).toBe(false);
    expect([...contentsOf(copy).keys()]).toEqual(["[Content_Types].xml"]);
  });

  it("still applies the declared limits first, without inflating", async () => {
    const zip = rawZip([{ ...honest("a.xml", "x"), uncompressedSize: 600 * 1024 * 1024 }]);
    expect(await refusal(verifiedZipCopy(zip, LIMITS))).toBeInstanceOf(ZipLimitError);
  });

  it("refuses a buffer that is not a zip at all", async () => {
    expect(await refusal(verifiedZipCopy(Buffer.from("not a zip at all"), LIMITS))).toBeInstanceOf(
      ZipFormatError
    );
  });
});

// ---------------------------------------------------------------------------
// Third review (PR #1243): one part, however large, is one reader's problem
// ---------------------------------------------------------------------------

describe("verifiedZipCopy — a ceiling per entry", () => {
  it("refuses an entry declared past maxEntryBytes, without inflating anything", async () => {
    // Declared 40 MiB, carrying a few bytes: refused from the directory alone,
    // so the wrong CRC is never reached.
    const zip = rawZip([
      honest("[Content_Types].xml", "<Types/>"),
      { ...honest("word/document.xml", "<w:document/>"), uncompressedSize: 40 * 1024 * 1024 },
    ]);
    const err = await refusal(verifiedZipCopy(zip, { ...LIMITS, maxEntryBytes: 32 * 1024 * 1024 }));
    expect(err).toBeInstanceOf(ZipLimitError);
    expect(err.message).toMatch(/word\/document\.xml/);
  });

  it("refuses it in assertZipWithinLimits too", () => {
    const zip = rawZip([{ ...honest("a.xml", "x"), uncompressedSize: 2000 }]);
    expect(() => assertZipWithinLimits(zip, { ...LIMITS, maxEntryBytes: 1000 })).toThrow(
      ZipLimitError
    );
  });

  it("keeps an archive whose every entry is within it", async () => {
    const zip = rawZip([honest("a.xml", "x".repeat(1000)), honest("b.xml", "y")]);
    const copy = await verifiedZipCopy(zip, { ...LIMITS, maxEntryBytes: 1000 });
    expect(contentsOf(copy).get("a.xml")!.length).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Fourth review (PR #1243): what a reader PARSES is capped, not what it stores
// ---------------------------------------------------------------------------

describe("verifiedZipCopy — a ceiling on the markup a reader may parse", () => {
  // mammoth builds a DOM from every XML part it reads, at 90-300x the part's
  // size (measured: a 2 MiB document part of tiny paragraphs peaks at 0.7 GB
  // through extractDocxText). A per-entry ceiling low enough for that would
  // refuse every document carrying a phone photo, so the ceiling is on the
  // MARKUP: every part a reader may parse as XML, summed. A picture only an
  // image relationship points at is never parsed, so it does not count.
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  const LIMITS_2K = { ...LIMITS, maxMarkupBytes: 2000 };

  const pictureBytes = () =>
    Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(5000, 7)]);

  function docRels(...rels: Array<[type: string, target: string]>): string {
    return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels
      .map(
        ([type, target], i) =>
          `<Relationship Id="rId${i}" Type="${REL}${type}" Target="${target}"/>`
      )
      .join("")}</Relationships>`;
  }

  const rootRels = docRels(["officeDocument", "word/document.xml"]);

  it("refuses markup past the ceiling, summed over every XML part, naming the total", async () => {
    const zip = rawZip([
      honest("[Content_Types].xml", "<Types/>"),
      honest("_rels/.rels", rootRels),
      honest("word/document.xml", `<w:document>${"x".repeat(900)}</w:document>`),
      honest("word/footnotes.xml", `<w:footnotes>${"y".repeat(900)}</w:footnotes>`),
    ]);
    const err = await refusal(verifiedZipCopy(zip, LIMITS_2K));
    expect(err).toBeInstanceOf(ZipLimitError);
    expect(err.message).toMatch(/markup/);
    expect(err.message).toMatch(/2000-byte limit/);
  });

  it("does not count a picture only an image relationship points at", async () => {
    const zip = rawZip([
      honest("[Content_Types].xml", "<Types/>"),
      honest("_rels/.rels", rootRels),
      honest("word/_rels/document.xml.rels", docRels(["image", "media/image1.png"])),
      honest("word/document.xml", "<w:document/>"),
      honest("word/media/image1.png", pictureBytes()),
    ]);
    const copy = await verifiedZipCopy(zip, LIMITS_2K);
    expect(contentsOf(copy).get("word/media/image1.png")!.length).toBe(5008);
  });

  it("counts a 'picture' that a relationship mammoth parses points at — its name and bytes do not matter", async () => {
    // mammoth reads the main document wherever _rels/.rels says it is, and it
    // parsed XML sitting behind a PNG signature without complaint (measured).
    const xmlBehindPng = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from(`<w:styles>${"s".repeat(4000)}</w:styles>`),
    ]);
    for (const rels of [
      [
        ["image", "media/image1.png"],
        ["styles", "media/image1.png"],
      ],
      [
        ["image", "media/image1.png"],
        ["styles", "./media/../media/image1.png"],
      ],
      [
        ["image", "media/image1.png"],
        ["styles", "MEDIA/IMAGE1.PNG"],
      ],
    ] as Array<Array<[string, string]>>) {
      const zip = rawZip([
        honest("[Content_Types].xml", "<Types/>"),
        honest("_rels/.rels", rootRels),
        honest("word/_rels/document.xml.rels", docRels(...rels)),
        honest("word/document.xml", "<w:document/>"),
        honest("word/media/image1.png", xmlBehindPng),
      ]);
      expect(await refusal(verifiedZipCopy(zip, LIMITS_2K))).toBeInstanceOf(ZipLimitError);
    }
  });

  it("counts every part when a relationship it would have to resolve is spelled in a way it does not decode", async () => {
    // An entity or a percent-escape in a parsed relationship's target names a
    // part only a decoder agrees on. Rather than decode like mammoth, it
    // gives up on telling pictures apart: everything counts.
    for (const target of ["media/image&#49;.png", "media/image%31.png", "media\\image1.png"]) {
      const zip = rawZip([
        honest("[Content_Types].xml", "<Types/>"),
        honest("_rels/.rels", rootRels),
        honest(
          "word/_rels/document.xml.rels",
          docRels(["image", "media/image1.png"], ["styles", target])
        ),
        honest("word/document.xml", "<w:document/>"),
        honest("word/media/image1.png", pictureBytes()),
      ]);
      expect(await refusal(verifiedZipCopy(zip, LIMITS_2K))).toBeInstanceOf(ZipLimitError);
    }
  });

  it("counts every part when a relationship part cannot be read unambiguously", async () => {
    const zip = rawZip([
      honest("[Content_Types].xml", "<Types/>"),
      honest("_rels/.rels", rootRels),
      honest(
        "word/_rels/document.xml.rels",
        `<Relationships><Relationship Id="a>b" Type="${REL}image" Target="media/image1.png"/></Relationships>`
      ),
      honest("word/document.xml", "<w:document/>"),
      honest("word/media/image1.png", pictureBytes()),
    ]);
    expect(await refusal(verifiedZipCopy(zip, LIMITS_2K))).toBeInstanceOf(ZipLimitError);
  });

  it("is off unless asked for: workbooks and decks keep their own limits", async () => {
    const zip = rawZip([honest("xl/worksheets/sheet1.xml", "x".repeat(5000))]);
    expect(contentsOf(await verifiedZipCopy(zip, LIMITS)).size).toBe(1);
  });
});

describe("verifiedZipCopy — a ZIP64 end record nothing needed", () => {
  // Some writers (.NET's System.IO.Packaging among them) put a ZIP64 end of
  // central directory record and its locator in front of the classic end
  // record even when every size fits in 32 bits. The classic record then
  // carries the real values, and nothing is deferred to ZIP64.

  /** `zip` with a ZIP64 end record + locator spliced between its directory and its end record. */
  function withZip64End(
    zip: Buffer,
    tweak: { entries?: number; locatorOffset?: number; recordSize?: number } = {}
  ): Buffer {
    const eocd = zip.length - 22;
    const entries = zip.readUInt16LE(eocd + 10);
    const cdSize = zip.readUInt32LE(eocd + 12);
    const cdOffset = zip.readUInt32LE(eocd + 16);
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(tweak.recordSize ?? 44), 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(tweak.entries ?? entries), 24);
    record.writeBigUInt64LE(BigInt(tweak.entries ?? entries), 32);
    record.writeBigUInt64LE(BigInt(cdSize), 40);
    record.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(tweak.locatorOffset ?? cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    return Buffer.concat([zip.subarray(0, eocd), record, locator, zip.subarray(eocd)]);
  }

  const plain = () =>
    rawZip([
      honest("[Content_Types].xml", "<Types/>"),
      honest("word/document.xml", "<w:document/>"),
    ]);

  it("accepts it when it agrees with the classic end record, and copies it without one", async () => {
    const zip = withZip64End(plain());
    const copy = await verifiedZipCopy(zip, LIMITS);
    expect([...contentsOf(copy).keys()]).toEqual(["[Content_Types].xml", "word/document.xml"]);
    expect(copy.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false);
  });

  it.each([
    ["a record that disagrees about the entry count", { entries: 7 }],
    ["a locator that points somewhere else", { locatorOffset: 3 }],
    ["a record carrying extensible data", { recordSize: 60 }],
  ])("refuses %s", async (_, tweak) => {
    expect(await refusal(verifiedZipCopy(withZip64End(plain(), tweak), LIMITS))).toBeInstanceOf(
      ZipFormatError
    );
  });

  it("still refuses an end record that defers its sizes to ZIP64", async () => {
    const zip = withZip64End(plain());
    zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16);
    expect(await refusal(verifiedZipCopy(zip, LIMITS))).toBeInstanceOf(ZipLimitError);
  });
});

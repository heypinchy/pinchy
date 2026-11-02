// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { constants as zlibConstants, deflateRawSync } from "zlib";
import mammoth from "mammoth";
import { extractDocxText } from "./docx-extract";
import {
  assembleZip,
  crc32,
  MAX_DOCX_MARKUP_BYTES,
  readZipEntries,
  ZipLimitError,
} from "./docx-zip-guard";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

describe("extractDocxText", () => {
  it("extracts plain paragraphs, headings, and table cell content", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);

    expect(result.text.length).toBeGreaterThan(50);

    // Every phrase from the golden file must round-trip through mammoth.
    const expected = readFileSync(join(FIXTURES, "simple.expected.txt"), "utf-8");
    for (const phrase of expected.split("\n").filter(Boolean)) {
      expect(result.text).toContain(phrase);
    }
  });

  it("does not return ZIP binary (PK header) for a real .docx", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);

    // A real .docx starts with `PK\x03\x04`. If extraction silently fell
    // back to utf-8 decoding the buffer, the agent would receive garbage
    // beginning with "PK" — this is the bug the issue is fixing.
    expect(result.text.startsWith("PK")).toBe(false);
  });

  it("throws a clear error when the buffer is not a valid .docx archive", async () => {
    const notDocx = Buffer.from("this is not a docx file", "utf-8");
    await expect(extractDocxText(notDocx)).rejects.toThrow();
  });

  it("emits Markdown headings (#, ##) for Word heading paragraphs", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);
    expect(result.text).toMatch(/^#\s+Customer Briefing\s*$/m);
    expect(result.text).toMatch(/^##\s+Pricing\s*$/m);
  });

  it("emits GFM table syntax (pipe-delimited rows) for Word tables", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);
    // Header row + separator row + data row, all pipe-delimited.
    expect(result.text).toMatch(/\|\s*SKU\s*\|\s*Quantity\s*\|\s*Unit Price\s*\|/);
    expect(result.text).toMatch(/\|\s*WIDGET-BLUE-01\s*\|\s*20\s*\|\s*EUR 42\.50\s*\|/);
  });

  it("replaces embedded images with a textual placeholder, not base64 data URLs", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);
    expect(result.text).not.toMatch(/!\[[^\]]*\]\(data:image\//);
    expect(result.text).not.toMatch(/<img[^>]/i);
  });

  it("replaces embedded images with [image] placeholder via the full pipeline", async () => {
    const buffer = readFileSync(join(FIXTURES, "with-image.docx"));
    const result = await extractDocxText(buffer);
    expect(result.text).toContain("[image]");
    expect(result.text).not.toMatch(/!\[[^\]]*\]\(data:image\//);
    expect(result.text).not.toMatch(/<img[^>]/i);
  });

  // Issue #424: a 50 MB compressed DOCX may decompress to multiple GB (zip
  // bomb). The declared-size guard must reject it BEFORE mammoth inflates.
  it("rejects a zip bomb before inflating it", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    await expect(extractDocxText(buffer, { maxDecompressedBytes: 10 })).rejects.toThrow(
      /decompressed size .* exceeds/i
    );
  });

  it("caps the extracted text length as a second defense layer", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    await expect(extractDocxText(buffer, { maxTextBytes: 10 })).rejects.toThrow(
      /extracted text .* exceeds/i
    );
  });

  it("extracts normally with default limits (regression guard)", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);
    expect(result.text.length).toBeGreaterThan(50);
  });

  // Release review v0.10.0: the declared-size guard above trusts the central
  // directory, and mammoth (via JSZip) inflates an entry whole before it
  // notices the entry was bigger than declared. The guard now inflates every
  // entry itself, capped at its declared size, and hands mammoth a copy built
  // only from entries that held up.
  it("rejects a .docx whose document inflates past its declared size, without calling mammoth", async () => {
    const fixture = readFileSync(join(FIXTURES, "simple.docx"));
    const lying = withLyingDocument(fixture, 64 * 1024 * 1024);
    const convert = vi.spyOn(mammoth, "convertToHtml");
    try {
      await expect(extractDocxText(lying)).rejects.toThrow(/inflates past|declared/i);
      expect(convert).not.toHaveBeenCalled();
    } finally {
      convert.mockRestore();
    }
  });
});

describe("extractDocxText — one part, however honest, is capped (third review, PR #1243)", () => {
  // mammoth builds a DOM from every XML part it reads, many times the part's
  // own size. A document part that tells the truth about being 33 MiB is
  // past what that is worth; it is refused before mammoth sees it.
  it("rejects a .docx whose document part is over 32 MiB, without calling mammoth", async () => {
    const fixture = readFileSync(join(FIXTURES, "simple.docx"));
    const big = withTruthfulDocument(fixture, 33 * 1024 * 1024);
    const convert = vi.spyOn(mammoth, "convertToHtml");
    try {
      await expect(extractDocxText(big)).rejects.toThrow(ZipLimitError);
      expect(convert).not.toHaveBeenCalled();
    } finally {
      convert.mockRestore();
    }
  });
});

describe("extractDocxText — the markup mammoth parses is capped, the pictures it skips are not (fourth review, PR #1243)", () => {
  // mammoth's DOM costs up to ~300x the XML it parses: a 1.9 MB .docx with a
  // 31 MiB document part peaked at 2.9 GB, and a 2 MiB part of tiny paragraphs
  // at 0.7 GB through this very function. The OpenClaw container gets 2 GB.
  const paragraphs = (bytes: number) =>
    "<w:p><w:r><w:t>word</w:t></w:r></w:p>".repeat(Math.ceil(bytes / 37));

  it("refuses more than 2 MiB of markup with an error that says so, without calling mammoth", async () => {
    const fixture = readFileSync(join(FIXTURES, "simple.docx"));
    const big = withDocumentXml(fixture, paragraphs(MAX_DOCX_MARKUP_BYTES + 1));
    const convert = vi.spyOn(mammoth, "convertToHtml");
    try {
      const err = await extractDocxText(big).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err).toBeInstanceOf(ZipLimitError);
      expect(err!.message).toMatch(/markup/);
      expect(convert).not.toHaveBeenCalled();
    } finally {
      convert.mockRestore();
    }
  });

  it("still reads a document whose PICTURE is bigger than the markup ceiling", async () => {
    // A phone photo is 3-5 MB. mammoth never parses it (the image converter
    // here does not even read it), so it must not count against the DOM.
    const fixture = readFileSync(join(FIXTURES, "with-image.docx"));
    const photo = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      randomBytes(MAX_DOCX_MARKUP_BYTES + 512 * 1024),
    ]);
    const withPhoto = replacePart(
      fixture,
      "word/media/b3e7639622b0359f8b4e73fcd9d43f43c7727804.png",
      photo
    );
    const { text } = await extractDocxText(withPhoto);
    expect(text).toContain("[image]");
  });
});

/** `docx` with `word/document.xml` replaced by a document whose body is `body`. */
function withDocumentXml(docx: Buffer, body: string): Buffer {
  return replacePart(
    docx,
    "word/document.xml",
    Buffer.from(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
    )
  );
}

/** `docx` with part `name` replaced by `content`, truthful about its size and CRC. */
function replacePart(docx: Buffer, name: string, content: Buffer): Buffer {
  return assembleZip(
    readZipEntries(docx).map((entry) => {
      if (entry.name === name) {
        return {
          name,
          method: 8,
          flags: 0,
          crc32: crc32(content),
          uncompressedSize: content.length,
          data: deflateRawSync(content),
        };
      }
      const at = entry.localHeaderOffset;
      const start = at + 30 + docx.readUInt16LE(at + 26) + docx.readUInt16LE(at + 28);
      return {
        name: entry.name,
        method: entry.method,
        flags: entry.flags,
        crc32: entry.crc32,
        uncompressedSize: entry.uncompressedSize,
        data: docx.subarray(start, start + entry.compressedSize),
      };
    })
  );
}

/** `docx` with `word/document.xml` replaced by `realBytes` of document, truthful about its size and CRC. */
function withTruthfulDocument(docx: Buffer, realBytes: number): Buffer {
  const head = Buffer.from(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  );
  const tail = Buffer.from("</w:body></w:document>");
  const xml = Buffer.concat([
    head,
    Buffer.alloc(realBytes - head.length - tail.length, 0x20),
    tail,
  ]);
  return assembleZip(
    readZipEntries(docx).map((entry) => {
      if (entry.name === "word/document.xml") {
        return {
          name: entry.name,
          method: 8,
          flags: 0,
          crc32: crc32(xml),
          uncompressedSize: xml.length,
          data: deflateRawSync(xml),
        };
      }
      const at = entry.localHeaderOffset;
      const start = at + 30 + docx.readUInt16LE(at + 26) + docx.readUInt16LE(at + 28);
      return {
        name: entry.name,
        method: entry.method,
        flags: entry.flags,
        crc32: entry.crc32,
        uncompressedSize: entry.uncompressedSize,
        data: docx.subarray(start, start + entry.compressedSize),
      };
    })
  );
}

/**
 * `docx` with `word/document.xml` replaced by a stream of `realBytes` spaces
 * that DECLARES the original document's size — a lie only inflating reveals.
 */
function withLyingDocument(docx: Buffer, realBytes: number): Buffer {
  const flush = { finishFlush: zlibConstants.Z_SYNC_FLUSH };
  const megabyte = deflateRawSync(Buffer.alloc(1024 * 1024, 0x20), flush);
  const stream = Buffer.concat([
    deflateRawSync(
      Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      ),
      flush
    ),
    ...Array.from({ length: Math.ceil(realBytes / (1024 * 1024)) }, () => megabyte),
    deflateRawSync(Buffer.from("</w:body></w:document>")),
  ]);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of readZipEntries(docx)) {
    const at = entry.localHeaderOffset;
    const start = at + 30 + docx.readUInt16LE(at + 26) + docx.readUInt16LE(at + 28);
    const data =
      entry.name === "word/document.xml"
        ? stream
        : docx.subarray(start, start + entry.compressedSize);
    const name = Buffer.from(entry.name);
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt32LE(entry.crc32, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.uncompressedSize, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.method, 10);
    record.writeUInt32LE(entry.crc32, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(entry.uncompressedSize, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    name.copy(record, 46);
    local.push(header, data);
    central.push(record);
    offset += header.length + data.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, eocd]);
}

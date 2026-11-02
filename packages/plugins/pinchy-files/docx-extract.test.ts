// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { constants as zlibConstants, deflateRawSync } from "zlib";
import {
  Document,
  ExternalHyperlink,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import mammoth from "mammoth";
import {
  DocxReaderOutOfMemoryError,
  extractDocxText,
  MAX_DOCX_EXTRACTED_TEXT_BYTES,
} from "./docx-extract";
import { docxToMarkdown } from "./docx-markdown";
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
    // mammoth runs in the reader child (sixth review); `read` is the only way
    // to it, so a reader that is never asked is a mammoth that never parsed.
    const fixture = readFileSync(join(FIXTURES, "simple.docx"));
    const lying = withLyingDocument(fixture, 64 * 1024 * 1024);
    const read = vi.fn(async () => "");
    await expect(extractDocxText(lying, { read })).rejects.toThrow(/inflates past|declared/i);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("extractDocxText — one part, however honest, is capped (third review, PR #1243)", () => {
  // mammoth builds a DOM from every XML part it reads, many times the part's
  // own size. A document part that tells the truth about being 33 MiB is
  // past what that is worth; it is refused before mammoth sees it.
  it("rejects a .docx whose document part is over 32 MiB, without calling mammoth", async () => {
    const fixture = readFileSync(join(FIXTURES, "simple.docx"));
    const big = withTruthfulDocument(fixture, 33 * 1024 * 1024);
    const read = vi.fn(async () => "");
    await expect(extractDocxText(big, { read })).rejects.toThrow(ZipLimitError);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("extractDocxText — the markup mammoth parses is capped, the pictures it skips are not (fourth review, PR #1243)", () => {
  // mammoth's DOM costs up to ~300x the XML it parses: a 1.9 MB .docx with a
  // 31 MiB document part peaked at 2.9 GB, and a 2 MiB part of tiny paragraphs
  // at 0.7 GB through this very function. The OpenClaw container gets 2 GB.
  const paragraphs = (bytes: number) =>
    "<w:p><w:r><w:t>word</w:t></w:r></w:p>".repeat(Math.ceil(bytes / 37));

  it("refuses more markup than the ceiling with an error that says so, without calling mammoth", async () => {
    const fixture = readFileSync(join(FIXTURES, "simple.docx"));
    const big = withDocumentXml(fixture, paragraphs(MAX_DOCX_MARKUP_BYTES + 1));
    const read = vi.fn(async () => "");
    const err = await extractDocxText(big, { read }).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(ZipLimitError);
    expect(err!.message).toMatch(/markup/);
    expect(read).not.toHaveBeenCalled();
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

describe("extractDocxText — a long document is read, not refused (seventh review, PR #1243)", () => {
  // The ceiling used to be 2 MiB: a LibreOffice-written report of 118 pages
  // is 1.72 MB of markup, so a document of ~140 pages was refused — a
  // regression, since main read it. The heap-capped child is what bounds the
  // memory now; the ceiling only turns away what the child could not read
  // anyway. Each run of these fixtures is one real child, so they get room.
  const LONG_DOCUMENT_TIMEOUT_MS = 60_000;

  it(
    "reads a 150-page Word document",
    async () => {
      const docx = withDocumentXml(
        readFileSync(join(FIXTURES, "simple.docx")),
        wordShapedPages(150)
      );
      const { text } = await extractDocxText(docx);
      expect(text).toContain("Seite 1 von 150");
      expect(text).toContain("Seite 150 von 150");
    },
    LONG_DOCUMENT_TIMEOUT_MS
  );

  it(
    "reads a 450-page Word document, just inside the ceiling",
    async () => {
      const body = wordShapedPages(450);
      expect(body.length).toBeLessThan(MAX_DOCX_MARKUP_BYTES);
      const docx = withDocumentXml(readFileSync(join(FIXTURES, "simple.docx")), body);
      const { text } = await extractDocxText(docx);
      expect(text).toContain("Seite 450 von 450");
    },
    LONG_DOCUMENT_TIMEOUT_MS
  );
});

describe("extractDocxText — the shapes the markup scan read differently are refused (sixth review, PR #1243)", () => {
  // The reviewer's three probes, built small: each hides megabytes of
  // paragraphs from the markup ceiling by a spelling mammoth (xmldom + JSZip)
  // resolves and the scan did not. 13 KB of .docx, 1.2-1.5 GB RSS here.
  // Each hides more paragraphs than the ceiling admits, so a scan that
  // counted them refuses the file; one that missed them would read it.
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  const rels = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
  const hidden = () =>
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${"<w:p><w:r><w:t>a</w:t></w:r></w:p>".repeat(Math.ceil((MAX_DOCX_MARKUP_BYTES + 1024 * 1024) / 34))}</w:body></w:document>`;
  const decoy = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello decoy</w:t></w:r></w:p></w:body></w:document>`;

  it.each([
    [
      "a prefixed Type mammoth reads as the Type",
      {
        "_rels/.rels": rels(
          `<Relationship Id="rId1" Type="${R}image" q:Type="${R}officeDocument" Target="word/document.png"/>`
        ),
        "word/document.png": hidden(),
      },
    ],
    [
      "a prefixed Target mammoth reads as the Target",
      {
        "_rels/.rels": rels(
          `<Relationship Id="rId1" Type="${R}officeDocument" Target="word/decoy.xml" q:Target="word/document.png"/><Relationship Id="rId2" Type="${R}image" Target="word/document.png"/>`
        ),
        "word/decoy.xml": decoy,
        "word/document.png": hidden(),
      },
    ],
    [
      "relationships under a name JSZip resolves to _rels/.rels",
      {
        "_rels/.rels/.": rels(
          `<Relationship Id="rId1" Type="${R}officeDocument" Target="word/document.png"/>`
        ),
        "word/_rels/pics.rels": rels(
          `<Relationship Id="rId1" Type="${R}image" Target="document.png"/>`
        ),
        "word/document.png": hidden(),
      },
    ],
  ])("refuses %s, without reading it", async (_, parts) => {
    const read = vi.fn(async () => "");
    await expect(extractDocxText(packageOf(parts), { read })).rejects.toThrow(/markup|resolve/);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("extractDocxText — mammoth runs in a child whose heap is capped (sixth review, PR #1243)", () => {
  // Three rounds running, the markup ceiling was bypassed because the scan
  // and mammoth disagreed about which parts are parsed. The scan stays as a
  // cheap first layer; what bounds the memory now is a child process with a
  // hard heap cap, whatever the scan missed.
  const paragraphs = (bytes: number) =>
    "<w:p><w:r><w:t>a</w:t></w:r></w:p>".repeat(Math.ceil(bytes / 34));

  it("reads a document in a child, never in this process", async () => {
    const convert = vi.spyOn(mammoth, "convertToHtml");
    try {
      const { text } = await extractDocxText(readFileSync(join(FIXTURES, "simple.docx")));
      expect(text).toMatch(/^#\s+Customer Briefing\s*$/m);
      expect(convert).not.toHaveBeenCalled();
    } finally {
      convert.mockRestore();
    }
  });

  it("answers a document past the child's heap with an error that says so — and this process stays small", async () => {
    // The scan is switched off here, which is exactly the case a bypass
    // produces: 4 MiB of tiny paragraphs that, read in-process, cost ~1.1 GB.
    const fixture = readFileSync(join(FIXTURES, "simple.docx"));
    const big = withDocumentXml(fixture, paragraphs(4 * 1024 * 1024));
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      const err = await extractDocxText(big, {
        maxMarkupBytes: Number.POSITIVE_INFINITY,
        maxHeapMb: 64,
      }).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err).toBeInstanceOf(DocxReaderOutOfMemoryError);
      expect(err!.message).toMatch(/more memory .*\(64 MB\)/);
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(peak - baseline).toBeLessThan(200 * 1024 * 1024);
  });

  it("hands back exactly what the in-process conversion gives, tables, links and pictures included", async () => {
    const linked = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun("See "),
                  new ExternalHyperlink({
                    link: "https://example.com/price-list",
                    children: [new TextRun("the price list")],
                  }),
                  new TextRun(" — Größe, naïve, 東京."),
                ],
              }),
              new Table({
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph("SKU")] }),
                      new TableCell({ children: [new Paragraph("Price")] }),
                    ],
                  }),
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph("A-1")] }),
                      new TableCell({ children: [new Paragraph("EUR 4.20")] }),
                    ],
                  }),
                ],
              }),
            ],
          },
        ],
      })
    );
    for (const docx of [
      readFileSync(join(FIXTURES, "simple.docx")),
      readFileSync(join(FIXTURES, "with-image.docx")),
      linked,
    ]) {
      const { text } = await extractDocxText(docx);
      expect(text).toBe(await docxToMarkdown(docx, MAX_DOCX_EXTRACTED_TEXT_BYTES));
    }
    const { text } = await extractDocxText(linked);
    expect(text).toContain("[the price list](https://example.com/price-list)");
    expect(text).toMatch(/\|\s*A-1\s*\|\s*EUR 4\.20\s*\|/);
  });

  it("still enforces the text cap, in the child", async () => {
    await expect(
      extractDocxText(readFileSync(join(FIXTURES, "simple.docx")), { maxTextBytes: 10 })
    ).rejects.toThrow(/extracted text .* exceeds/i);
  });
});

describe("extractDocxText — a reader that dies is not a verdict on the document (sixth review, PR #1243)", () => {
  // Only V8's own heap-limit banner says the document was too big. A child
  // killed from outside, one that crashes, one that never got ready, and one
  // that runs out of time are infrastructure, and say so.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-docx-reader-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const stub = (name: string, body: string) => {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, body);
    return path;
  };
  const docx = () => readFileSync(join(FIXTURES, "simple.docx"));
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected a rejection");
      },
      (err: unknown) => err as Error
    );

  it("reports a child killed without the heap banner as a reader failure, not as too much memory", async () => {
    const childEntry = stub(
      "killed",
      `process.send({ type: "ready" }); process.once("message", () => process.kill(process.pid, "SIGKILL"));`
    );
    const err = await failure(extractDocxText(docx(), { childEntry }));
    expect(err).not.toBeInstanceOf(DocxReaderOutOfMemoryError);
    expect(err.message).toMatch(/killed/);
  });

  it("reports a child that exits before it is ready as a reader that could not start", async () => {
    const childEntry = stub("broken", `process.exit(3);`);
    const err = await failure(extractDocxText(docx(), { childEntry }));
    expect(err).not.toBeInstanceOf(DocxReaderOutOfMemoryError);
    expect(err.message).toMatch(/before it was ready/);
  });

  it("kills a child that takes too long, and says so", async () => {
    const childEntry = stub(
      "slow",
      `process.send({ type: "ready" }); process.once("message", () => setInterval(() => {}, 1000));`
    );
    const err = await failure(extractDocxText(docx(), { childEntry, timeoutMs: 300 }));
    expect(err).not.toBeInstanceOf(DocxReaderOutOfMemoryError);
    expect(err.message).toMatch(/longer than/);
  });

  it("runs one reader at a time, so the memory one may use is the memory all of them use", async () => {
    const log = join(dir, "log.txt");
    const childEntry = stub(
      "logged",
      `import { appendFileSync } from "node:fs";
       process.send({ type: "ready" });
       process.once("message", () => {
         appendFileSync(${JSON.stringify(log)}, "start\\n");
         setTimeout(() => {
           appendFileSync(${JSON.stringify(log)}, "end\\n");
           process.send({ type: "result", text: "ok" }, () => process.exit(0));
         }, 150);
       });`
    );
    const results = await Promise.all([1, 2, 3].map(() => extractDocxText(docx(), { childEntry })));
    expect(results.map((r) => r.text)).toEqual(["ok", "ok", "ok"]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "start",
      "end",
      "start",
      "end",
      "start",
      "end",
    ]);
  });
});

/** A .docx assembled from `parts` (plus a content-types part), each deflated and truthful about its size. */
function packageOf(parts: Record<string, string>): Buffer {
  const all: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
    ...parts,
  };
  return assembleZip(
    Object.entries(all).map(([name, content]) => {
      const bytes = Buffer.from(content);
      return {
        name,
        method: 8,
        flags: 0,
        crc32: crc32(bytes),
        uncompressedSize: bytes.length,
        data: deflateRawSync(bytes),
      };
    })
  );
}

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

/**
 * `pages` pages of the paragraphs Word writes: revision ids on every
 * paragraph and run, paragraph and run properties, a sentence split over six
 * runs (spell-check and edit sessions do that) — about 16 KB of markup a
 * page, heavier than the 14.6 KB a page LibreOffice writes. Each page ends
 * with "Seite N von <pages>", so a test can see the last page was read.
 */
function wordShapedPages(pages: number): string {
  const words =
    "Die Wartung der Anlage erfolgt gemäß den Vorgaben des Herstellers und wird quartalsweise dokumentiert".split(
      " "
    );
  const rPr = `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-AT"/></w:rPr>`;
  let n = 0;
  const id = () => (0x10000000 + n++).toString(16).toUpperCase();
  const run = (text: string) =>
    `<w:r w:rsidRPr="${id()}">${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const paragraph = (runs: string) =>
    `<w:p w:rsidR="${id()}" w:rsidRDefault="${id()}" w:rsidP="${id()}"><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/>${rPr}</w:pPr>${runs}<w:proofErr w:type="spellStart"/><w:bookmarkStart w:id="0" w:name="_Toc${id()}"/><w:bookmarkEnd w:id="0"/></w:p>`;
  const body: string[] = [];
  for (let page = 1; page <= pages; page++) {
    for (let p = 0; p < 8; p++) {
      const runs = Array.from({ length: 6 }, (_, r) =>
        run(
          `${Array.from({ length: 10 }, (_, w) => words[(page + p + r + w) % words.length]).join(" ")} `
        )
      ).join("");
      body.push(paragraph(runs));
    }
    body.push(paragraph(run(`Seite ${page} von ${pages}`)));
    body.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
  }
  return body.join("");
}

/**
 * What the knowledge base checks about an Office file BEFORE a reader touches
 * it: that it is the format its extension claims, that it does not inflate
 * into a heap-sized surprise, and that it carries no relationship that makes
 * LibreOffice go and fetch something (release review v0.10.0, findings 1+2).
 *
 * Everything here is deterministic and runs on every PR; the matching proof
 * that LibreOffice itself no longer fetches is the gated
 * `office-convert.libreoffice.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import ExcelJS from "exceljs";
import mammoth from "mammoth";

import {
  OFFICE_MAX_FILE_BYTES,
  prepareOfficeSource,
  readGuardedDocx,
  readWorkbookBuffer,
  sanitizeOoxmlPackage,
  stripExternalRelationships,
  XLSX_MAX_FILE_BYTES,
  XLSX_MAX_PART_BYTES,
} from "@/lib/knowledge/office-preflight";
import { OfficeFileRejectedError } from "@/lib/knowledge/office-formats";
import { deflatedPart, inflatePart, readZipEntries } from "@/lib/knowledge/office-zip";
import {
  declaredBomb,
  docxWith,
  lyingEntry,
  ooxmlPart,
  PNG_1X1,
  REL_HYPERLINK,
  REL_IMAGE,
  relationships,
  relType,
  replaceEntry,
  truthfulSpacesEntry,
  zipOf,
} from "@/test-helpers/office-zip";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinchy-kb-preflight-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, body: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

async function rejection(promise: Promise<unknown>): Promise<OfficeFileRejectedError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    return err as OfficeFileRejectedError;
  }
  throw new Error("expected the preflight to reject, but it resolved");
}

const PRESENTATION_PART = (qname: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><${qname} xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;

const rel = (id: string, type: string, target: string, mode?: string) =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ""}/>`;

describe("stripExternalRelationships", () => {
  it("removes an external image and keeps the internal parts", () => {
    const xml = relationships(
      rel("rId1", REL_IMAGE, "media/image1.png"),
      rel("rId2", REL_IMAGE, "http://10.0.0.5/pixel.png", "External")
    );
    const out = stripExternalRelationships(xml);
    expect(out.removed).toBe(1);
    expect(out.xml).toContain("media/image1.png");
    expect(out.xml).not.toContain("10.0.0.5");
    expect(out.xml).toContain("</Relationships>");
  });

  it("removes hyperlinks too: a hyperlink-typed relationship can be dereferenced as an image link", () => {
    // Measured against LibreOffice 26.2: `<a:blip r:link="rId9"/>` resolves the
    // id WITHOUT checking the relationship's Type, so an allow-list that
    // spares "plain hyperlinks" is a fetch primitive with a different label on
    // it. The link text survives in the document; only the URL goes.
    const xml = relationships(rel("rId9", REL_HYPERLINK, "http://10.0.0.5/x.png", "External"));
    expect(stripExternalRelationships(xml)).toEqual({
      xml: relationships(),
      removed: 1,
    });
  });

  it("is not fooled by a `>` inside an attribute value", () => {
    const xml = relationships(rel("rId2", REL_IMAGE, "http://10.0.0.5/a?x=>y", "External"));
    expect(stripExternalRelationships(xml).removed).toBe(1);
    expect(stripExternalRelationships(xml).xml).not.toContain("10.0.0.5");
  });

  it("is not fooled by single quotes, attribute order, or a namespace prefix", () => {
    const xml =
      `<?xml version="1.0"?><r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<r:Relationship TargetMode='External' Target='file:///etc/hostname' Type='${REL_IMAGE}' Id='rId5'/>` +
      `</r:Relationships>`;
    const out = stripExternalRelationships(xml);
    expect(out.removed).toBe(1);
    expect(out.xml).not.toContain("etc/hostname");
  });

  it("removes a relationship whose TargetMode is entity-obfuscated", () => {
    // `&#69;xternal` decodes to `External` in an XML parser but is invisible to
    // a text match for the word. Anything that is not plainly Internal goes.
    const xml = relationships(
      `<Relationship Id="rId2" Type="${REL_IMAGE}" Target="http://10.0.0.5/a.png" TargetMode="&#69;xternal"/>`
    );
    expect(stripExternalRelationships(xml).removed).toBe(1);
  });

  it("removes an internal-mode relationship whose target carries a URI scheme", () => {
    const xml = relationships(
      rel("rId2", REL_IMAGE, "http://10.0.0.5/a.png"),
      rel("rId3", REL_IMAGE, "file:///etc/passwd", "Internal"),
      rel("rId4", REL_IMAGE, "&#104;ttp://10.0.0.5/b.png")
    );
    const out = stripExternalRelationships(xml);
    expect(out.removed).toBe(3);
  });

  it("handles the open/close element form", () => {
    const xml = relationships(
      `<Relationship Id="rId2" Type="${REL_IMAGE}" Target="http://10.0.0.5/a.png" TargetMode="External"></Relationship>`,
      rel("rId1", REL_IMAGE, "media/image1.png")
    );
    const out = stripExternalRelationships(xml);
    expect(out.removed).toBe(1);
    expect(out.xml).toBe(relationships(rel("rId1", REL_IMAGE, "media/image1.png")));
  });

  it("refuses a hostile part of unterminated tags in linear time, not quadratic", () => {
    // 300k `<Relationship ` openers and no `>` anywhere: a scanner that
    // re-reads to the end of the part from each opener does ~10^11 steps here
    // and hangs the web process on a ~4 MiB part that deflates to almost nothing.
    const hostile = "<Relationship ".repeat(300_000);
    const started = Date.now();
    expect(() => stripExternalRelationships(hostile)).toThrow(OfficeFileRejectedError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("leaves a part with no external relationship byte-identical", () => {
    const xml = relationships(rel("rId1", REL_IMAGE, "media/image1.png"));
    expect(stripExternalRelationships(xml)).toEqual({ xml, removed: 0 });
  });
});

describe("sanitizeOoxmlPackage", () => {
  const external = rel("rId9", REL_IMAGE, "http://10.0.0.5/pixel.png", "External");

  it("returns the very same buffer when nothing needs removing", () => {
    // The picture really is in the package: a relationship to a part that is
    // NOT there is cut (see the allow-list suite), so a clean fixture needs it.
    const pkg = docxWith({
      documentRels: relationships(rel("rId1", REL_IMAGE, "media/a.png")),
      parts: { "word/media/a.png": PNG_1X1 },
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.removed).toBe(0);
    expect(out.data).toBe(pkg);
  });

  it("rewrites the relationship part, keeps every other part byte-for-byte, and stays a readable package", async () => {
    // The picture link is deliberately NOT referenced from the body here:
    // mammoth throws on a dangling `r:link` (LibreOffice does not — that case
    // is the gated canary), and this test is about the archive being sound.
    const pkg = docxWith({
      text: "Quarterly figures for Domžale",
      documentRels: relationships(external),
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.removed).toBe(1);

    const before = readZipEntries(pkg);
    const after = readZipEntries(out.data);
    expect(after.map((e) => e.name)).toEqual(before.map((e) => e.name));

    const text = (buf: Buffer, entries: typeof after, name: string) =>
      inflatePart(
        buf,
        entries.find((e) => e.name === name)!,
        1 << 20
      ).toString("utf8");
    expect(text(out.data, after, "word/_rels/document.xml.rels")).not.toContain("10.0.0.5");
    expect(text(out.data, after, "word/document.xml")).toBe(text(pkg, before, "word/document.xml"));

    // An INDEPENDENT reader (mammoth, via jszip, which also verifies CRCs)
    // opens it and finds the text: the rewrite is a real archive, and the
    // document whose picture link we cut still reads.
    const { value } = await mammoth.extractRawText({ buffer: out.data });
    expect(value).toContain("Quarterly figures for Domžale");
  });

  it("strips presentation relationships as well", () => {
    const slideRels = relationships(
      rel(
        "rId1",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
        "../slideLayouts/slideLayout1.xml"
      ),
      rel("rId2", REL_IMAGE, "http://10.0.0.5/slide.png", "External")
    );
    // The layout the slide points at is in the package, as in any real deck:
    // a relationship to a missing part is cut as well (allow-list suite).
    const pkg = zipOf({
      "[Content_Types].xml": "<Types/>",
      "ppt/slides/_rels/slide1.xml.rels": slideRels,
      "ppt/slides/slide1.xml": PRESENTATION_PART("p:sld"),
      "ppt/slideLayouts/slideLayout1.xml": PRESENTATION_PART("p:sldLayout"),
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.removed).toBe(1);
    const entries = readZipEntries(out.data);
    const rels = inflatePart(
      out.data,
      entries.find((e) => e.name === "ppt/slides/_rels/slide1.xml.rels")!,
      1 << 20
    ).toString("utf8");
    expect(rels).toContain("slideLayout1.xml");
    expect(rels).not.toContain("10.0.0.5");
  });

  it("refuses a relationship part that is not UTF-8 text", () => {
    // A UTF-16 part would slip past every text match above while a parser
    // still reads it — so it is refused rather than guessed at.
    const utf16 = Buffer.from(`﻿${relationships(external)}`, "utf16le");
    const pkg = zipOf({ "[Content_Types].xml": "<Types/>", "word/_rels/document.xml.rels": utf16 });
    expect(() => sanitizeOoxmlPackage(pkg)).toThrow(OfficeFileRejectedError);
  });

  it("refuses a relationship part that inflates past its ceiling, whatever it declares", () => {
    const bomb = zipOf({
      "[Content_Types].xml": "<Types/>",
      "word/_rels/document.xml.rels": Buffer.alloc(8 * 1024 * 1024, 0x20),
    });
    expect(() => sanitizeOoxmlPackage(bomb)).toThrow(OfficeFileRejectedError);
  });
});

describe("prepareOfficeSource", () => {
  const OLE2 = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(512),
  ]);

  it("passes a legacy binary document through untouched", async () => {
    const prepared = await prepareOfficeSource(file("a.doc", OLE2));
    expect(prepared.data.equals(OLE2)).toBe(true);
    expect(prepared.relationshipsRemoved).toBe(0);
  });

  it("accepts an RTF document that is named .doc (Word writes these)", async () => {
    const rtf = Buffer.from("{\\rtf1\\ansi Hello\\par}");
    expect((await prepareOfficeSource(file("a.doc", rtf))).data.equals(rtf)).toBe(true);
  });

  it("accepts an OOXML package named .doc", async () => {
    const pkg = docxWith({ documentRels: relationships() });
    expect((await prepareOfficeSource(file("a.doc", pkg))).data.equals(pkg)).toBe(true);
  });

  it.each([
    ["html.doc", "<html><body><img src='http://10.0.0.5/x.png'></body></html>"],
    ["html.docx", "<!DOCTYPE html><html><body>hi</body></html>"],
    ["text.doc", "just some text, not a Word file"],
    [
      "flat.doc",
      `<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>`,
    ],
    ["rtf-deck.pptx", "{\\rtf1 not a deck}"],
  ])("refuses %s: the bytes are not the format the extension promises", async (name, body) => {
    const err = await rejection(prepareOfficeSource(file(name, body)));
    expect(err.code).toBe("unexpected_content");
  });

  it("refuses a zip that is not an OOXML package (an ODF package renamed .docx)", async () => {
    const odt = zipOf({
      mimetype: "application/vnd.oasis.opendocument.text",
      "content.xml": "<x/>",
    });
    expect((await rejection(prepareOfficeSource(file("a.docx", odt)))).code).toBe(
      "unexpected_content"
    );
  });

  it("returns an untouched copy of a clean package, and a rewritten one when it carries external links", async () => {
    const clean = docxWith({
      documentRels: relationships(rel("rId1", REL_IMAGE, "media/a.png")),
      parts: { "word/media/a.png": PNG_1X1 },
    });
    const a = await prepareOfficeSource(file("clean.docx", clean));
    expect(a.data.equals(clean)).toBe(true);
    expect(a.relationshipsRemoved).toBe(0);

    const dirty = docxWith({
      documentRels: relationships(rel("rId9", REL_IMAGE, "http://10.0.0.5/p.png", "External")),
      pictureRelId: "rId9",
    });
    const b = await prepareOfficeSource(file("dirty.docx", dirty));
    expect(b.relationshipsRemoved).toBe(1);
    expect(b.data.includes("10.0.0.5")).toBe(false);
  });

  it("refuses a file past the size cap without reading it", async () => {
    const path = file("big.doc", OLE2);
    const err = await rejection(prepareOfficeSource(path, { maxBytes: 100 }));
    expect(err.code).toBe("too_large");
    expect(OFFICE_MAX_FILE_BYTES).toBeGreaterThan(100 * 1024 * 1024);
  });

  it("refuses a decompression bomb from its central directory alone — fast, and without inflating", async () => {
    // 4 GB declared (just under the ZIP64 marker), ~200 bytes on disk.
    const bomb = declaredBomb(0xfffffffe, "word/document.xml");
    const path = file("bomb.docx", bomb);
    const heapBefore = process.memoryUsage().arrayBuffers;
    const started = Date.now();

    const err = await rejection(prepareOfficeSource(path));

    expect(err.code).toBe("too_large");
    expect(Date.now() - started).toBeLessThan(2000);
    // Nothing near the declared 4 GB was ever allocated.
    expect(process.memoryUsage().arrayBuffers - heapBefore).toBeLessThan(50 * 1024 * 1024);
  });

  it("refuses a bomb built to stay under the ceiling by its compression ratio", async () => {
    const bomb = declaredBomb(100 * 1024 * 1024, "word/document.xml");
    expect((await rejection(prepareOfficeSource(file("ratio.docx", bomb)))).code).toBe("too_large");
  });
});

describe("readWorkbookBuffer", () => {
  async function realWorkbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Data").addRows([["Name"], ["Alice"]]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("returns an ordinary workbook as a verified copy: the same parts, holding the same bytes", async () => {
    // Not the file's own bytes any more: exceljs is handed an archive rebuilt
    // from the entries the guard inflated and checked, so it cannot read a
    // byte the guard did not (a junk prefix, a hidden local entry). What it
    // reads is the same workbook, part for part.
    const xlsx = await realWorkbook();
    const copy = await readWorkbookBuffer(file("a.xlsx", xlsx));
    expect(partsOf(copy)).toEqual(partsOf(xlsx));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(copy as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.getWorksheet("Data")!.getCell("A2").value).toBe("Alice");
  });

  it("refuses a decompression bomb before exceljs ever sees it", async () => {
    const bomb = declaredBomb(0xfffffffe);
    const heapBefore = process.memoryUsage().arrayBuffers;
    const started = Date.now();

    const err = await rejection(readWorkbookBuffer(file("bomb.xlsx", bomb)));

    expect(err.code).toBe("too_large");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(process.memoryUsage().arrayBuffers - heapBefore).toBeLessThan(50 * 1024 * 1024);
  });

  it("refuses a ratio bomb that stays under the size ceiling", async () => {
    const bomb = declaredBomb(120 * 1024 * 1024);
    expect((await rejection(readWorkbookBuffer(file("ratio.xlsx", bomb)))).code).toBe("too_large");
  });

  it("refuses a file past the size cap", async () => {
    const err = await rejection(
      readWorkbookBuffer(file("big.xlsx", await realWorkbook()), { maxBytes: 100 })
    );
    expect(err.code).toBe("too_large");
    expect(XLSX_MAX_FILE_BYTES).toBeLessThanOrEqual(OFFICE_MAX_FILE_BYTES);
  });

  it("refuses a file that is not a zip at all instead of handing it to the reader", async () => {
    // This used to read "leaves a file that is not a zip at all to the
    // reader's own diagnosis" and assert the bytes came back untouched. That
    // expectation WAS the hole (release review v0.10.0): every guard parse
    // failure was handed on, and "the guard could not parse it" includes "64
    // junk bytes in front of a bomb", which JSZip opens anyway. Fail closed.
    // extractXlsx still reports it as XlsxExtractionError (xlsx-extract.test.ts).
    const junk = Buffer.from("this is not a workbook");
    expect((await rejection(readWorkbookBuffer(file("junk.xlsx", junk)))).code).toBe(
      "unexpected_content"
    );
  });

  it("refuses a sheet that inflates past the size it declares, before anything holds it", async () => {
    // 1000 bytes declared, 512 MiB real. The declared-size checks pass it; a
    // reader that trusts them inflates all of it (measured: 1.43 GB RSS for
    // 1.2 GB). The guard inflates it itself, capped at what it declares.
    const bomb = replaceEntry(
      await realWorkbook(),
      "xl/worksheets/sheet1.xml",
      lyingEntry("xl/worksheets/sheet1.xml", {
        head: SHEET_HEAD,
        tail: SHEET_TAIL,
        realBytes: 512 * MiB,
        declaredBytes: 1000,
      })
    );
    const started = Date.now();
    const arrayBuffersBefore = process.memoryUsage().arrayBuffers;

    const err = await rejection(readWorkbookBuffer(file("lying.xlsx", bomb)));

    expect(err.code).toBe("too_large");
    expect(err.message).toMatch(/inflates past/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(process.memoryUsage().arrayBuffers - arrayBuffersBefore).toBeLessThan(32 * MiB);
  });

  it("refuses a bomb hidden behind a junk prefix — the parse failure is a refusal, not a hand-off", async () => {
    // Truthful about its 450 MiB, so the ratio rule refuses it bare. With 64
    // bytes in front the central directory no longer parses; that used to be
    // swallowed and the file handed to exceljs, whose JSZip skips the prefix
    // and inflated it (measured: 989 MB RSS from a 465 KB file).
    const truthful = replaceEntry(
      await realWorkbook(),
      "xl/worksheets/sheet1.xml",
      truthfulSpacesEntry("xl/worksheets/sheet1.xml", {
        head: SHEET_HEAD,
        tail: SHEET_TAIL,
        spaceBytes: 450 * MiB,
      })
    );
    expect((await rejection(readWorkbookBuffer(file("bare.xlsx", truthful)))).code).toBe(
      "too_large"
    );

    const prefixed = Buffer.concat([Buffer.alloc(64, 0x41), truthful]);
    expect((await rejection(readWorkbookBuffer(file("prefixed.xlsx", prefixed)))).code).toBe(
      "unexpected_content"
    );
  });
});

describe("readWorkbookBuffer — one sheet part is capped (fourth review, PR #1243)", () => {
  // exceljs's cell model costs ~20x the sheet XML. The reader runs in a
  // heap-capped child (xlsx-isolated.ts), and this is the last line in front
  // of it: a part past the cap is refused by its size, before exceljs builds
  // anything, rather than by an out-of-memory death in the child.
  /** A truthful, ordinarily compressible sheet of `bytes` (rows of numbers, ~13:1). */
  function sheetOf(bytes: number): Buffer {
    const rows: string[] = [];
    let size = SHEET_HEAD.length + SHEET_TAIL.length;
    for (let r = 2; size < bytes; r++) {
      const row = `<row r="${r}">${"ABCDEFGHIJ"
        .split("")
        .map((c) => `<c r="${c}${r}"><v>${r * 7}</v></c>`)
        .join("")}</row>`;
      rows.push(row);
      size += row.length;
    }
    return Buffer.from(SHEET_HEAD + rows.join("") + SHEET_TAIL);
  }

  async function workbookWithSheet(sheet: Buffer): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Data").addRows([["Name"], ["Alice"]]);
    return replaceEntry(
      Buffer.from(await wb.xlsx.writeBuffer()),
      "xl/worksheets/sheet1.xml",
      deflatedPart("xl/worksheets/sheet1.xml", sheet)
    );
  }

  it("refuses a sheet part past the cap as too large, naming the part", async () => {
    const xlsx = await workbookWithSheet(sheetOf(XLSX_MAX_PART_BYTES + 64 * 1024));
    const err = await rejection(readWorkbookBuffer(file("wide.xlsx", xlsx)));
    expect(err.code).toBe("too_large");
    expect(err.message).toContain("xl/worksheets/sheet1.xml");
    expect(err.message).toContain(`${XLSX_MAX_PART_BYTES}-byte limit for one entry`);
  });

  it("reads a sheet part just under the cap", async () => {
    const xlsx = await workbookWithSheet(sheetOf(XLSX_MAX_PART_BYTES - 64 * 1024));
    await expect(readWorkbookBuffer(file("big.xlsx", xlsx))).resolves.toBeInstanceOf(Buffer);
  });
});

describe("readGuardedDocx", () => {
  it("returns a verified copy of an ordinary document", async () => {
    const docx = docxWith({ text: "Quarterly figures", documentRels: relationships() });
    const copy = await readGuardedDocx(file("a.docx", docx));
    expect(partsOf(copy)).toEqual(partsOf(docx));
  });

  it("refuses a document that inflates past the size it declares", async () => {
    const bomb = replaceEntry(
      docxWith({ documentRels: relationships() }),
      "word/document.xml",
      lyingEntry("word/document.xml", {
        head: "<w:document><w:body>",
        tail: "</w:body></w:document>",
        realBytes: 256 * MiB,
        declaredBytes: 1000,
      })
    );
    expect((await rejection(readGuardedDocx(file("lying.docx", bomb)))).code).toBe("too_large");
  });

  it("refuses a document behind a junk prefix", async () => {
    const prefixed = Buffer.concat([
      Buffer.alloc(64, 0x41),
      docxWith({ documentRels: relationships() }),
    ]);
    expect((await rejection(readGuardedDocx(file("prefixed.docx", prefixed)))).code).toBe(
      "unexpected_content"
    );
  });
});

const MiB = 1024 * 1024;
const SHEET_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>`;
const SHEET_TAIL = `</sheetData></worksheet>`;

/** name -> inflated content (hex), through an independent read of each entry. */
function partsOf(zip: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readZipEntries(zip)) {
    out[entry.name] = inflatePart(zip, entry, 64 * MiB).toString("hex");
  }
  return out;
}

describe("sanitizeOoxmlPackage — relationship allow-list (release review v0.10.0, blocker 1)", () => {
  // A relationship being INTERNAL is not enough. An internal aFChunk to an
  // embedded HTML part makes LibreOffice import that HTML, which resolves
  // `<img src="file:///…">` even under the locked profile: local PDF/SVG text
  // landed in the indexed PDF, local PNGs were embedded. An internal SVG
  // picture with an `<image href="file:///…">` does the same. So what stays is
  // what rendering text and layout needs, pointing at parts that are what the
  // relationship says they are; everything else is cut, and the few things
  // that would lose real content by being cut are refused instead.
  const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

  function docRelsAfter(pkg: Buffer): string {
    const out = sanitizeOoxmlPackage(pkg);
    const entry = readZipEntries(out.data).find((e) => e.name === "word/_rels/document.xml.rels")!;
    return inflatePart(out.data, entry, 1 << 20).toString("utf8");
  }

  function refusedWith(pkg: Buffer): OfficeFileRejectedError {
    try {
      sanitizeOoxmlPackage(pkg);
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeFileRejectedError);
      return err as OfficeFileRejectedError;
    }
    throw new Error("expected the package to be refused");
  }

  it("keeps every relationship an ordinary Word document renders from", () => {
    const parts: Record<string, string | Buffer> = {
      "word/styles.xml": ooxmlPart("w:styles"),
      "word/numbering.xml": ooxmlPart("w:numbering"),
      "word/fontTable.xml": ooxmlPart("w:fonts"),
      "word/settings.xml": ooxmlPart("w:settings"),
      "word/webSettings.xml": ooxmlPart("w:webSettings"),
      "word/header1.xml": ooxmlPart("w:hdr"),
      "word/footer1.xml": ooxmlPart("w:ftr"),
      "word/footnotes.xml": ooxmlPart("w:footnotes"),
      "word/endnotes.xml": ooxmlPart("w:endnotes"),
      "word/comments.xml": ooxmlPart("w:comments"),
      "word/theme/theme1.xml": `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`,
      "word/media/image1.png": PNG_1X1,
      "word/stylesWithEffects.xml": ooxmlPart("w:styles"),
    };
    const documentRels = relationships(
      rel("rId1", relType("styles"), "styles.xml"),
      rel("rId2", relType("numbering"), "numbering.xml"),
      rel("rId3", relType("fontTable"), "fontTable.xml"),
      rel("rId4", relType("settings"), "settings.xml"),
      rel("rId5", relType("webSettings"), "webSettings.xml"),
      rel("rId6", relType("header"), "header1.xml"),
      rel("rId7", relType("footer"), "footer1.xml"),
      rel("rId8", relType("footnotes"), "footnotes.xml"),
      rel("rId9", relType("endnotes"), "endnotes.xml"),
      rel("rId10", relType("comments"), "comments.xml"),
      rel("rId11", relType("theme"), "theme/theme1.xml"),
      rel("rId12", REL_IMAGE, "media/image1.png"),
      rel("rId13", REL_IMAGE, "/word/media/image1.png"),
      rel(
        "rId14",
        "http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects",
        "stylesWithEffects.xml"
      ),
      // Strict OOXML spells the same types under another namespace.
      rel("rId15", "http://purl.oclc.org/ooxml/officeDocument/relationships/styles", "styles.xml")
    );
    const pkg = docxWith({ documentRels, parts });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.removed).toBe(0);
    expect(out.data).toBe(pkg);
  });

  it("keeps an Office part that starts with a UTF-8 byte-order mark, as some real Word files do", () => {
    // Found by converting a real corpus: two contracts' settings.xml began
    // with EF BB BF, and a root-element check that skipped only U+FEFF (the
    // BOM as a decoded character) refused both documents.
    const pkg = docxWith({
      documentRels: relationships(rel("rId1", relType("settings"), "settings.xml")),
      parts: {
        "word/settings.xml": Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(ooxmlPart("w:settings")),
        ]),
      },
    });
    expect(sanitizeOoxmlPackage(pkg).removed).toBe(0);
  });

  it("keeps a presentation's slide, layout, master, notes and theme chain", () => {
    const PML = (q: string) => PRESENTATION_PART(q);
    const pkg = zipOf({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": relationships(rel("rId1", relType("officeDocument"), "ppt/presentation.xml")),
      "ppt/presentation.xml": PML("p:presentation"),
      "ppt/_rels/presentation.xml.rels": relationships(
        rel("rId1", relType("slideMaster"), "slideMasters/slideMaster1.xml"),
        rel("rId2", relType("slide"), "slides/slide1.xml"),
        rel("rId3", relType("notesMaster"), "notesMasters/notesMaster1.xml"),
        rel("rId4", relType("presProps"), "presProps.xml"),
        rel("rId5", relType("viewProps"), "viewProps.xml"),
        rel("rId6", relType("tableStyles"), "tableStyles.xml")
      ),
      "ppt/slideMasters/slideMaster1.xml": PML("p:sldMaster"),
      "ppt/slides/slide1.xml": PML("p:sld"),
      "ppt/slides/_rels/slide1.xml.rels": relationships(
        rel("rId1", relType("slideLayout"), "../slideLayouts/slideLayout1.xml"),
        rel("rId2", relType("notesSlide"), "../notesSlides/notesSlide1.xml"),
        rel("rId3", REL_IMAGE, "../media/image1.png")
      ),
      "ppt/slideLayouts/slideLayout1.xml": PML("p:sldLayout"),
      "ppt/notesSlides/notesSlide1.xml": PML("p:notes"),
      "ppt/notesMasters/notesMaster1.xml": PML("p:notesMaster"),
      "ppt/presProps.xml": PML("p:presentationPr"),
      "ppt/viewProps.xml": PML("p:viewPr"),
      "ppt/tableStyles.xml": `<?xml version="1.0"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`,
      "ppt/media/image1.png": PNG_1X1,
    });
    // `altChunksRemoved` joined the result when an altChunk became something
    // cut rather than refused (second review); a clean deck has none.
    expect(sanitizeOoxmlPackage(pkg)).toEqual({ data: pkg, removed: 0, altChunksRemoved: 0 });
  });

  it.each([
    ["oleObject", "embeddings/oleObject1.bin"],
    ["package", "embeddings/Microsoft_Excel_Worksheet.xlsx"],
    ["subDocument", "sub.docx"],
    ["attachedTemplate", "template.dotx"],
    ["frame", "frame.htm"],
    ["customXml", "../customXml/item1.xml"],
    ["hyperlink", "other.xml"],
    ["printerSettings", "printerSettings1.bin"],
    ["control", "activeX/activeX1.xml"],
    ["video", "media/clip.mp4"],
  ])("cuts an internal %s relationship: not something a page is rendered from", (type, target) => {
    const pkg = docxWith({
      documentRels: relationships(
        rel("rId1", relType("styles"), "styles.xml"),
        rel("rId2", relType(type), target)
      ),
      parts: { "word/styles.xml": ooxmlPart("w:styles") },
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.removed).toBe(1);
    const rels = docRelsAfter(pkg);
    expect(rels).toContain("styles.xml");
    expect(rels).not.toContain(target);
  });

  it("cuts a VBA project and any type it does not know, whatever namespace it claims", () => {
    const pkg = docxWith({
      documentRels: relationships(
        rel(
          "rId1",
          "http://schemas.microsoft.com/office/2006/relationships/vbaProject",
          "vbaProject.bin"
        ),
        rel("rId2", "http://example.com/relationships/whatever", "x.xml"),
        // Entity-spelled type: an XML parser decodes it to `styles`, a text
        // match does not — cut, never guessed at.
        rel(
          "rId3",
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/st&#121;les",
          "styles.xml"
        )
      ),
      parts: { "word/styles.xml": ooxmlPart("w:styles") },
    });
    expect(sanitizeOoxmlPackage(pkg).removed).toBe(3);
  });

  // CORRECTED (second review, PR #1243): these two used to assert that an
  // altChunk REFUSES the whole package. Refusing threw away every word of an
  // otherwise ordinary document over one embedded chunk; cutting the chunk —
  // relationship AND element — keeps the rest searchable and still never lets
  // a second import filter see it. The operator log says what was dropped.
  function partAfter(pkg: Buffer, name: string): string {
    const out = sanitizeOoxmlPackage(pkg);
    const entry = readZipEntries(out.data).find((e) => e.name === name)!;
    return inflatePart(out.data, entry, 1 << 20).toString("utf8");
  }

  it("cuts an altChunk relationship and its element, and keeps the rest of the document", async () => {
    // The reviewer's vector: an embedded HTML part whose <img src="file://…">
    // LibreOffice resolves, locked profile or not.
    const pkg = docxWith({
      text: "Words around the chunk",
      documentRels: relationships(rel("rIdA", relType("aFChunk"), "afchunk.htm")),
      body: `<w:altChunk r:id="rIdA"/><w:p><w:r><w:t>Words after the chunk</w:t></w:r></w:p>`,
      parts: { "word/afchunk.htm": `<html><body><img src="file:///etc/hostname"></body></html>` },
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.removed).toBe(1);
    expect(out.altChunksRemoved).toBe(1);
    expect(docRelsAfter(pkg)).not.toContain("afchunk.htm");
    const document = partAfter(pkg, "word/document.xml");
    expect(document).not.toMatch(/altChunk/);
    // An independent reader still finds every word the author wrote around it.
    const { value } = await mammoth.extractRawText({ buffer: out.data });
    expect(value).toContain("Words around the chunk");
    expect(value).toContain("Words after the chunk");
  });

  it("cuts an altChunk element that borrows an allowed relationship's id, and keeps the picture", () => {
    // LibreOffice resolves an r:id without checking the relationship's Type,
    // so an altChunk can point at an id labelled `image` just as well. The
    // relationship is a real picture and stays; the element that would import
    // it through a second filter goes.
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", REL_IMAGE, "media/image1.png")),
      body: `<w:altChunk r:id="rId5"><w:altChunkPr><w:matchSrc/></w:altChunkPr></w:altChunk>`,
      parts: { "word/media/image1.png": PNG_1X1 },
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.removed).toBe(0);
    expect(out.altChunksRemoved).toBe(1);
    expect(docRelsAfter(pkg)).toContain("media/image1.png");
    const document = partAfter(pkg, "word/document.xml");
    expect(document).not.toMatch(/altChunk/);
    expect(document).toContain("Hello canary document");
  });

  it("cuts an altChunk in a header too, whatever prefix it is spelled with", () => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId1", relType("header"), "header1.xml")),
      parts: {
        "word/header1.xml": `<?xml version="1.0"?><x:hdr xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:p><x:r><x:t>Header words</x:t></x:r></x:p><x:altChunk r:id="rId9" /></x:hdr>`,
      },
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.altChunksRemoved).toBe(1);
    const header = partAfter(pkg, "word/header1.xml");
    expect(header).not.toMatch(/altChunk/);
    expect(header).toContain("Header words");
  });

  it("refuses an altChunk element that never ends: what follows it is not ours to guess", () => {
    const pkg = docxWith({
      documentRels: relationships(),
      body: `<w:altChunk r:id="rId5"><w:altChunkPr/>`,
    });
    expect(refusedWith(pkg).code).toBe("unexpected_content");
  });

  it.each([
    ["an HTML page", Buffer.from(`<html><body><img src="file:///etc/hostname"></body></html>`)],
    ["a nested Office package", zipOf({ "[Content_Types].xml": "<Types/>" })],
    [
      "an OLE2 compound file",
      Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(64)]),
    ],
    [
      "a flat ODF document",
      Buffer.from(
        `<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>`
      ),
    ],
    ["nothing recognisable", Buffer.from("just bytes")],
  ])("cuts an image relationship whose target is %s, not a picture", (_, bytes) => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", REL_IMAGE, "media/image1.png")),
      parts: { "word/media/image1.png": bytes },
    });
    expect(sanitizeOoxmlPackage(pkg).removed).toBe(1);
    expect(docRelsAfter(pkg)).not.toContain("image1.png");
  });

  const svg = (inner: string) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">${inner}</svg>`
    );

  it.each([
    ["an image by file URL", `<image xlink:href="file:///etc/hostname.png"/>`],
    ["an image over http", `<image href="http://10.0.0.5/x.png"/>`],
    ["another SVG by path", `<image xlink:href="/home/pinchy/secret.svg"/>`],
    ["an entity-spelled reference", `<image href="&#102;ile:///etc/x.png"/>`],
    ["a CSS url()", `<rect style="fill:url(file:///etc/x.png)"/>`],
    ["a stylesheet import", `<style>@import "http://10.0.0.5/x.css";</style>`],
    ["a DOCTYPE", `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/hostname">]><text>&x;</text>`],
  ])("cuts an SVG picture that reaches outside itself: %s", (_, inner) => {
    // Measured against LibreOffice 26.2: an internal SVG picture with
    // <image href="file:///…"> draws that local file into the PDF, and a local
    // SVG's text lands in the text layer — the locked profile does not stop it.
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", REL_IMAGE, "media/image1.svg")),
      parts: { "word/media/image1.svg": svg(inner) },
    });
    expect(sanitizeOoxmlPackage(pkg).removed).toBe(1);
  });

  it("keeps a self-contained SVG picture, internal references and embedded rasters included", () => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", REL_IMAGE, "media/image1.svg")),
      parts: {
        "word/media/image1.svg": svg(
          `<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/>` +
            `<image href="data:image/png;base64,${PNG_1X1.toString("base64")}"/>`
        ),
      },
    });
    expect(sanitizeOoxmlPackage(pkg).removed).toBe(0);
  });

  it.each([
    ["an HTML page", `<html><body>hi</body></html>`],
    ["XHTML", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>`],
    [
      "a flat ODF document",
      `<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>`,
    ],
    ["an SVG", `<svg xmlns="http://www.w3.org/2000/svg"/>`],
    [
      "a part with a DOCTYPE",
      `<!DOCTYPE w:styles [<!ENTITY x SYSTEM "file:///etc/hostname">]><w:styles ${W_NS}>&x;</w:styles>`,
    ],
  ])("refuses a styles relationship whose target is %s, not an Office part", (_, content) => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId1", relType("styles"), "styles.xml")),
      parts: { "word/styles.xml": content },
    });
    expect(refusedWith(pkg).code).toBe("unexpected_content");
  });

  it("refuses a header relationship that points at a nested package", () => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId1", relType("header"), "header1.xml")),
      parts: { "word/header1.xml": docxWith({ documentRels: relationships() }) },
    });
    expect(refusedWith(pkg).code).toBe("unexpected_content");
  });

  it("refuses a relationship part that declares a DOCTYPE: entities could spell relationships no text match sees", () => {
    const pkg = docxWith({
      documentRels:
        `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e "<Relationship Id='rId9' Type='${relType("aFChunk")}' Target='a.htm'/>">]>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">&e;</Relationships>`,
    });
    expect(refusedWith(pkg).code).toBe("unexpected_content");
  });

  it.each([
    ["a part that is not in the package", "media/missing.png"],
    ["a percent-encoded name", "media/image%31.png"],
    ["a path that climbs out of the package", "../../image1.png"],
    ["a backslash path", "media\\image1.png"],
    ["a query string", "media/image1.png?x"],
  ])(
    "cuts a relationship whose target is %s: what it resolves to is not ours to guess",
    (_, target) => {
      const pkg = docxWith({
        documentRels: relationships(rel("rId5", REL_IMAGE, target)),
        parts: { "word/media/image1.png": PNG_1X1 },
      });
      expect(sanitizeOoxmlPackage(pkg).removed).toBe(1);
    }
  );

  it.each(["simple.docx", "with-image.docx"])(
    "leaves a real Word document's text exactly as it was (%s)",
    async (fixture) => {
      const original = readFileSync(
        join(import.meta.dirname, "../../../../../plugins/pinchy-files/test-fixtures", fixture)
      );
      const prepared = await prepareOfficeSource(file(fixture, original));
      const before = await mammoth.extractRawText({ buffer: original });
      const after = await mammoth.extractRawText({ buffer: prepared.data });
      expect(after.value).toBe(before.value);
      expect(prepared.relationshipsRemoved).toBe(0);
    }
  );
});

describe("the second review (PR #1243): no regex on file bytes is super-linear", () => {
  // `attributesOf` used a global regex whose `[^\s=/>]+` re-scanned a long
  // token from every offset: a 942-byte .docx carrying one 50 000-character
  // token in a relationship tag held the web process for 2.7 s, 100 000 for
  // 11 s — and the part may be 4 MiB. The KB worker shares that process.
  // Just under the 4 MiB a relationship part may inflate to, so it is the
  // tag that is refused, not the part's size.
  const BIG = 4 * 1024 * 1024 - 4096;

  it("refuses a 4 MiB single-token relationship tag in well under a second", () => {
    const xml = relationships(
      `<Relationship Id="rId1" Type="${relType("styles")}" Target="styles.xml" ${"A".repeat(BIG)}/>`
    );
    const started = Date.now();
    expect(() => stripExternalRelationships(xml)).toThrow(OfficeFileRejectedError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("refuses the reviewer's package — a single-token relationship deflated to a few hundred bytes — in bounded time", async () => {
    const pkg = zipOf({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": relationships(
        `<Relationship Id="rId1" Type="${relType("officeDocument")}" Target="word/document.xml" ${"A".repeat(BIG)}/>`
      ),
      "word/document.xml": ooxmlPart("w:document"),
    });
    expect(pkg.length).toBeLessThan(64 * 1024);
    const started = Date.now();
    const err = await rejection(prepareOfficeSource(file("redos.docx", pkg)));
    expect(err.code).toBe("unexpected_content");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("refuses an Office part whose root tag is a 4 MiB token, in bounded time", () => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId1", relType("styles"), "styles.xml")),
      parts: {
        "word/styles.xml": `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${"A".repeat(BIG)}/>`,
      },
    });
    const started = Date.now();
    expect(() => sanitizeOoxmlPackage(pkg)).toThrow(OfficeFileRejectedError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still reads a relationship with many attributes, in any quoting, at ordinary length", () => {
    const xml = relationships(
      `<Relationship  Id = 'rId1'\n\tType="${REL_IMAGE}" Target='http://10.0.0.5/a.png' TargetMode = "External" />`,
      rel("rId2", REL_IMAGE, "media/image1.png")
    );
    const out = stripExternalRelationships(xml);
    expect(out.removed).toBe(1);
    expect(out.xml).toContain("media/image1.png");
    expect(out.xml).not.toContain("10.0.0.5");
  });

  it("refuses a relationship that names an attribute twice: which one a parser keeps is not ours to guess", () => {
    const xml = relationships(
      `<Relationship Id="rId1" Type="${REL_IMAGE}" Target="media/a.png" TargetMode="Internal" TargetMode="External"/>`
    );
    expect(() => stripExternalRelationships(xml)).toThrow(OfficeFileRejectedError);
  });

  it("refuses a relationship tag that is not attributes at all", () => {
    const xml = relationships(`<Relationship Id="rId1" junk Target="media/a.png"/>`);
    expect(() => stripExternalRelationships(xml)).toThrow(OfficeFileRejectedError);
  });
});

describe("the second review (PR #1243): a kept part is vetted by what it IS, not by its relationship's Type", () => {
  // LibreOffice resolves `r:embed` by Id and never looks at the Type, then
  // detects a picture's format from its bytes. So a part kept as a FONT, or
  // as Office XML, is drawn as an SVG if its bytes say SVG — and an SVG reads
  // local files under the locked profile. Measured against LibreOffice 26.2,
  // every vector below put a local file's text into the PDF before this.
  const gzip = (text: string) => gzipSync(Buffer.from(text));
  const reachingSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200"><image width="400" height="60" xlink:href="file:///etc/hostname"/></svg>`;

  function cutCount(relType_: string, target: string, part: string | Buffer): number {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", relType_, target)),
      parts: { [`word/${target}`]: part },
    });
    return sanitizeOoxmlPackage(pkg).removed;
  }

  function refused(relType_: string, target: string, part: string | Buffer) {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", relType_, target)),
      parts: { [`word/${target}`]: part },
    });
    expect(() => sanitizeOoxmlPackage(pkg)).toThrow(OfficeFileRejectedError);
  }

  it("cuts a font that is a gzipped SVG (svgz)", () => {
    expect(cutCount(relType("font"), "fonts/font1.odttf", gzip(reachingSvg))).toBe(1);
  });

  it("cuts a font whose first kilobytes carry an SVG element behind binary junk", () => {
    const part = Buffer.concat([Buffer.from([0, 1, 2, 3, 0xff, 0xfe]), Buffer.from(reachingSvg)]);
    expect(cutCount(relType("font"), "fonts/font1.odttf", part)).toBe(1);
  });

  it("keeps an ordinary obfuscated font", () => {
    const font = Buffer.alloc(2048);
    for (let i = 0; i < font.length; i++) font[i] = (i * 131 + 7) & 0xff;
    expect(cutCount(relType("font"), "fonts/font1.odttf", font)).toBe(0);
  });

  it("cuts a picture that is a gzipped SVG (svgz): what it reaches for cannot be read without inflating it", () => {
    expect(cutCount(REL_IMAGE, "media/image1.svgz", gzip(reachingSvg))).toBe(1);
  });

  it.each([
    [
      "an SVG root in a Microsoft namespace",
      `<svg xmlns="http://schemas.microsoft.com/office/2006/x" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="file:///etc/hostname"/></svg>`,
    ],
    [
      "a prefixed SVG root in a Microsoft namespace",
      `<s:svg xmlns:s="http://schemas.microsoft.com/office/2006/x" xmlns="http://www.w3.org/2000/svg"/>`,
    ],
    [
      "HTML in the WordprocessingML namespace",
      `<w:html xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
    ],
    [
      "an Office root with an SVG element in its first kilobytes",
      `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><!-- <svg --></w:hdr>`,
    ],
  ])("refuses a header relationship whose target is %s", (_, content) => {
    refused(relType("header"), "header1.xml", content);
  });

  it.each([
    ["an SVG", reachingSvg],
    ["a gzipped SVG", gzip(reachingSvg)],
    ["text", "just some words, no picture at all"],
  ])("cuts an SVG picture whose data: URL claims to be a PNG but decodes to %s", (_, payload) => {
    const b64 = Buffer.from(payload).toString("base64");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/png;base64,${b64}"/></svg>`;
    expect(cutCount(REL_IMAGE, "media/image1.svg", svg)).toBe(1);
  });

  it("cuts an SVG picture with a foreignObject: an HTML island can carry its own references", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="file:///etc/hostname"/></foreignObject></svg>`;
    expect(cutCount(REL_IMAGE, "media/image1.svg", svg)).toBe(1);
  });

  it("cuts a PNG-looking picture whose first kilobytes also carry an SVG element", () => {
    const part = Buffer.concat([PNG_1X1.subarray(0, 16), Buffer.from(reachingSvg)]);
    expect(cutCount(REL_IMAGE, "media/image1.png", part)).toBe(1);
  });
});

describe("the second review (PR #1243): RTF named .doc", () => {
  // An RTF file named .doc is accepted (Word writes these), and LibreOffice
  // draws an RTF `\pict` by sniffing its bytes — an SVG inside one read a
  // local file under the locked profile (reviewer's posing.doc). So the
  // picture and object groups are cut, and so is every field instruction
  // (INCLUDEPICTURE and INCLUDETEXT read files; the field's last result, the
  // text a reader saw, stays). Ordinary text is untouched.
  const svgHex = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="file:///etc/hostname"/></svg>`
  ).toString("hex");

  async function sanitized(rtf: string): Promise<string> {
    return (await prepareOfficeSource(file("posing.doc", rtf))).data.toString("latin1");
  }

  it("cuts a picture group and keeps the text around it", async () => {
    const out = await sanitized(
      `{\\rtf1\\ansi Before words\\par {\\pict\\pngblip\\picw400\\pich200 ${svgHex}}\\par After words\\par}`
    );
    expect(out).not.toContain(svgHex);
    expect(out).not.toMatch(/\\pict/);
    expect(out).toContain("Before words");
    expect(out).toContain("After words");
  });

  it.each([
    ["a shape picture", `{\\*\\shppict{\\pict\\pngblip ${svgHex}}}`],
    ["a fallback picture", `{\\nonshppict{\\pict\\wmetafile8 ${svgHex}}}`],
    [
      "an embedded object",
      `{\\object\\objemb{\\*\\objdata ${svgHex}}{\\result{\\pict ${svgHex}}}}`,
    ],
    ["a picture with a binary run full of braces", `{\\pict\\pngblip\\bin4 }}}}${svgHex}}`],
  ])("cuts %s", async (_, group) => {
    const out = await sanitized(`{\\rtf1\\ansi Kept words ${group} Tail words\\par}`);
    expect(out).not.toContain(svgHex);
    expect(out).toContain("Kept words");
    expect(out).toContain("Tail words");
  });

  it.each(["INCLUDEPICTURE", "INCLUDETEXT"])(
    "cuts the %s field's instruction and keeps its last result",
    async (field) => {
      const out = await sanitized(
        `{\\rtf1\\ansi {\\field{\\*\\fldinst { ${field} "file:///etc/hostname" }}{\\fldrslt CACHED RESULT}}\\par}`
      );
      expect(out).not.toContain(field);
      expect(out).not.toContain("hostname");
      expect(out).toContain("CACHED RESULT");
    }
  );

  it("leaves escaped braces and an RTF with nothing to cut exactly as they were", async () => {
    const rtf = `{\\rtf1\\ansi Escaped \\{brace\\} words\\par}`;
    expect(await sanitized(rtf)).toBe(rtf);
  });

  it("handles a million nested groups in bounded time", async () => {
    const rtf = `{\\rtf1 ${"{".repeat(1_000_000)}\\pict ${svgHex}`;
    const started = Date.now();
    const out = await sanitized(rtf);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).not.toContain(svgHex);
  });
});

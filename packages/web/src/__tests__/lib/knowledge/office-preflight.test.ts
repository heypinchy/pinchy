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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import mammoth from "mammoth";

import {
  OFFICE_MAX_FILE_BYTES,
  prepareOfficeSource,
  readWorkbookBuffer,
  sanitizeOoxmlPackage,
  stripExternalRelationships,
  XLSX_MAX_FILE_BYTES,
} from "@/lib/knowledge/office-preflight";
import { OfficeFileRejectedError } from "@/lib/knowledge/office-formats";
import { inflatePart, readZipEntries } from "@/lib/knowledge/office-zip";
import {
  declaredBomb,
  docxWith,
  REL_HYPERLINK,
  REL_IMAGE,
  relationships,
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
    const pkg = docxWith({ documentRels: relationships(rel("rId1", REL_IMAGE, "media/a.png")) });
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
    const pkg = zipOf({
      "[Content_Types].xml": "<Types/>",
      "ppt/slides/_rels/slide1.xml.rels": slideRels,
      "ppt/slides/slide1.xml": "<p:sld/>",
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
    expect(prepared.externalLinksRemoved).toBe(0);
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
    const clean = docxWith({ documentRels: relationships(rel("rId1", REL_IMAGE, "media/a.png")) });
    const a = await prepareOfficeSource(file("clean.docx", clean));
    expect(a.data.equals(clean)).toBe(true);
    expect(a.externalLinksRemoved).toBe(0);

    const dirty = docxWith({
      documentRels: relationships(rel("rId9", REL_IMAGE, "http://10.0.0.5/p.png", "External")),
      pictureRelId: "rId9",
    });
    const b = await prepareOfficeSource(file("dirty.docx", dirty));
    expect(b.externalLinksRemoved).toBe(1);
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

  it("returns the bytes of an ordinary workbook", async () => {
    const xlsx = await realWorkbook();
    expect((await readWorkbookBuffer(file("a.xlsx", xlsx))).equals(xlsx)).toBe(true);
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

  it("leaves a file that is not a zip at all to the reader's own diagnosis", async () => {
    // exceljs reports it, the extractor wraps it as XlsxExtractionError — the
    // "cannot read this" contract that already exists. Only LIMIT violations
    // are rejected here.
    const junk = Buffer.from("this is not a workbook");
    expect((await readWorkbookBuffer(file("junk.xlsx", junk))).equals(junk)).toBe(true);
  });
});

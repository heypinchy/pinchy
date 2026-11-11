/**
 * What the knowledge base checks about an Office file BEFORE a reader touches
 * it: that it is the format its extension claims, that it does not inflate
 * into a heap-sized surprise, and that it carries no relationship that makes
 * LibreOffice go and fetch something.
 *
 * Everything here is deterministic and runs on every PR; the matching proof
 * that LibreOffice itself does not fetch is the gated
 * `office-convert.libreoffice.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
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
  XLSX_MAX_ENTRY_BYTES,
  XLSX_MAX_FILE_BYTES,
  XLSX_MAX_PART_BYTES,
} from "@/lib/knowledge/office-preflight";
import { OfficeFileRejectedError } from "@/lib/knowledge/office-formats";
import {
  assembleZip,
  deflatedPart,
  inflatePart,
  rawPart,
  readZipEntries,
  type ZipPart,
} from "@/lib/knowledge/office-zip";
import {
  declaredBomb,
  documentXml,
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
  withAliases,
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

  // XML names are not ASCII: `ä` is as good a prefix letter as `r`. A scanner
  // that only knows `[A-Za-z_]` prefixes reads past such an element, and the
  // reader behind it does not.
  it("reads a relationship whose prefix is spelled with non-ASCII letters", () => {
    const xml =
      `<?xml version="1.0"?><ä:Relationships xmlns:ä="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<ä:Relationship Id="rId5" Type="${REL_IMAGE}" Target="file:///etc/hostname" TargetMode="External"/>` +
      `</ä:Relationships>`;
    const out = stripExternalRelationships(xml);
    expect(out.removed).toBe(1);
    expect(out.xml).not.toContain("etc/hostname");
  });

  it("refuses a relationship that declares a non-ASCII prefix of its own, like any other prefixed attribute", () => {
    const xml = relationships(
      `<ä:Relationship xmlns:ä="http://schemas.openxmlformats.org/package/2006/relationships" Id="rId5" Type="${REL_IMAGE}" Target="file:///etc/hostname" TargetMode="External"/>`
    );
    expect(() => stripExternalRelationships(xml)).toThrow(OfficeFileRejectedError);
  });

  it("refuses a part where cutting one relationship would join the text around it into another", () => {
    // `<Relation` + [a cut relationship] + `ship …/>` reads, once the cut is
    // made, as a relationship nobody vetted. What a cut leaves is held to the
    // same rules as what came in.
    const xml = relationships(
      `<Relation${rel("rId1", REL_IMAGE, "http://10.0.0.5/b.png", "External")}ship Id="rId2" Type="${REL_IMAGE}" Target="http://10.0.0.5/a.png" TargetMode="External"/>`
    );
    expect(() => stripExternalRelationships(xml)).toThrow(OfficeFileRejectedError);
  });

  it("refuses a part where cutting a relationship would join the text around it into a DOCTYPE", () => {
    const xml = relationships(
      `<!DOC${rel("rId1", REL_IMAGE, "http://10.0.0.5/b.png", "External")}TYPE x>`,
      rel("rId2", REL_IMAGE, "media/image1.png")
    );
    expect(() => stripExternalRelationships(xml)).toThrow(OfficeFileRejectedError);
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
    // The ceiling is the per-part XML limit, 64 MiB (a separate 4 MiB one
    // refused real link-heavy documents).
    const bomb = zipOf({
      "[Content_Types].xml": "<Types/>",
      "word/_rels/document.xml.rels": Buffer.alloc(65 * 1024 * 1024, 0x20),
    });
    expect(() => sanitizeOoxmlPackage(bomb)).toThrow(OfficeFileRejectedError);
  });
});

describe("a refusal quotes a name read from the package, it never pastes it", () => {
  // A part name is the file author's: up to 65,535 bytes, newlines included.
  // The refusal is the reason the knowledge-base ingest logs, one line per
  // file — pasted verbatim, a name writes lines of its own there.
  const BREAKS_A_LINE =
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  const FORGED = `[kb-ingest] /data/hr/ok.docx: not converted — FORGED ${"Q".repeat(3000)}`;

  function expectOneBoundedLine(err: OfficeFileRejectedError) {
    expect(err.message).not.toMatch(BREAKS_A_LINE);
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).toContain('"word');
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

  it("for a relationship part that is not UTF-8 text", () => {
    const pkg = docxWith({
      documentRels: relationships(),
      parts: { [`word/_rels/x\n${FORGED}\n.rels`]: Buffer.from([0xff, 0xfe, 0x00, 0xc3]) },
    });
    expectOneBoundedLine(refusedWith(pkg));
  });

  it("for a relationship part that is encrypted", () => {
    const rels = Buffer.from(relationships());
    const encrypted: ZipPart = {
      ...deflatedPart(`word/_rels/x\n${FORGED}\n.rels`, rels),
      flags: 0x0001,
    };
    const base = docxWith({ documentRels: relationships() });
    const pkg = assembleZip([
      ...readZipEntries(base).map((entry) => rawPart(base, entry)),
      encrypted,
    ]);
    expectOneBoundedLine(refusedWith(pkg));
  });

  it("for a part a relationship points at that is not Office XML", () => {
    // A target that breaks a line is cut, never followed — but nothing stops
    // one from being thousands of characters long.
    const target = `h${"Q".repeat(3000)}.xml`;
    const pkg = docxWith({
      documentRels: relationships(rel("rIdH", relType("header"), target)),
      parts: { [`word/${target}`]: "not XML at all" },
    });
    expectOneBoundedLine(refusedWith(pkg));
  });

  it("for an entry whose name a reader would resolve to another, as the whole preflight reports it", async () => {
    const pkg = docxWith({
      documentRels: relationships(),
      parts: { [`word\\x\n${FORGED}\n.xml`]: Buffer.from([0xff]) },
    });
    const err = await rejection(prepareOfficeSource(file("forged.docx", pkg)));
    expectOneBoundedLine(err);
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

  it("hands LibreOffice a macro-enabled .docm with its VBA project cut away (#1409)", async () => {
    // A `.docm` is a `.docx` whose package also carries `vbaProject.bin`. The
    // conversion never runs a macro — the soffice profile disables macro
    // execution (office-soffice.ts, asserted in office-convert.adapter.test.ts)
    // — and the package LibreOffice reads does not even reference one.
    const pkg = docxWith({
      text: "Wartungsplan",
      documentRels: relationships(
        rel(
          "rId1",
          "http://schemas.microsoft.com/office/2006/relationships/vbaProject",
          "vbaProject.bin"
        )
      ),
      parts: { "word/vbaProject.bin": randomBytes(64) },
    });

    const prepared = await prepareOfficeSource(file("Wartungsplan.docm", pkg));

    expect(prepared.relationshipsRemoved).toBe(1);
    const rels = readZipEntries(prepared.data).find(
      (e) => e.name === "word/_rels/document.xml.rels"
    )!;
    expect(inflatePart(prepared.data, rels, 1 << 20).toString("utf8")).not.toContain("vbaProject");
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

  it("reports how large the staged package unpacks — what LibreOffice needs as scratch to load it", async () => {
    // The converter sizes the room it demands of the volume from this: a
    // 152 KB .docx can unpack to 26.6 MB, and LibreOffice unpacks it into
    // scratch space while loading. Counted on what is STAGED, the rewrite
    // included, since that is what LibreOffice loads.
    const unpacked = (data: Buffer) =>
      readZipEntries(data).reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    const clean = docxWith({
      documentRels: relationships(rel("rId1", REL_IMAGE, "media/a.png")),
      parts: { "word/media/a.png": PNG_1X1, "word/big.xml": "<x>" + " ".repeat(500_000) + "</x>" },
    });
    const a = await prepareOfficeSource(file("clean.docx", clean));
    expect(a.unpackedBytes).toBe(unpacked(clean));
    expect(a.unpackedBytes).toBeGreaterThan(500_000);
    expect(clean.length).toBeLessThan(100_000);

    const dirty = docxWith({
      documentRels: relationships(rel("rId9", REL_IMAGE, "http://10.0.0.5/p.png", "External")),
      pictureRelId: "rId9",
    });
    const b = await prepareOfficeSource(file("dirty.docx", dirty));
    expect(b.relationshipsRemoved).toBe(1);
    expect(b.unpackedBytes).toBe(unpacked(b.data));
    expect(b.unpackedBytes).toBeLessThan(unpacked(dirty));

    // Not archives: LibreOffice reads them as they are, nothing to unpack.
    expect((await prepareOfficeSource(file("a.doc", OLE2))).unpackedBytes).toBeNull();
    const rtf = Buffer.from("{\\rtf1\\ansi Hello\\par}");
    expect((await prepareOfficeSource(file("b.doc", rtf))).unpackedBytes).toBeNull();
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

  it("refuses a package whose directory lists one picture many times, instead of staging it once per listing", async () => {
    // 1 MiB of picture on disk, listed 100 times: every listing checks out on
    // its own, and a copy built listing by listing stages 100 MiB.
    const picture = Buffer.concat([PNG_1X1, randomBytes(1024 * 1024)]);
    const pkg = withAliases(
      docxWith({
        documentRels: relationships(rel("rId1", REL_IMAGE, "media/a.png")),
        parts: { "word/media/a.png": picture },
      }),
      "word/media/a.png",
      Array.from({ length: 99 }, (_, i) => `word/media/a${i}.png`)
    );
    expect(pkg.length).toBeLessThan(2 * 1024 * 1024);

    const err = await rejection(prepareOfficeSource(file("aliased.docx", pkg)));
    expect(err.code).toBe("unexpected_content");
    expect(err.message).toMatch(/shares bytes with another entry/);
  });

  it("stages a package no larger than the file it came from", async () => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId1", REL_IMAGE, "media/a.png")),
      parts: { "word/media/a.png": Buffer.concat([PNG_1X1, randomBytes(64 * 1024)]) },
    });
    expect((await prepareOfficeSource(file("plain.docx", pkg))).data.length).toBeLessThanOrEqual(
      pkg.length
    );
  });
});

describe("readWorkbookBuffer", () => {
  async function realWorkbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Data").addRows([["Name"], ["Alice"]]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("returns an ordinary workbook as a verified copy: the same parts, holding the same bytes", async () => {
    // Not the file's own bytes: exceljs is handed an archive rebuilt
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

  it("refuses a workbook whose directory lists one picture many times", async () => {
    // exceljs is handed the verified copy, so a copy built listing by listing
    // would hand it the picture once per listing: 100 MiB from a 1 MiB file.
    const picture = Buffer.concat([PNG_1X1, randomBytes(1024 * 1024)]);
    const xlsx = await realWorkbook();
    const aliased = withAliases(
      assembleZip([
        ...readZipEntries(xlsx).map((entry) => rawPart(xlsx, entry)),
        deflatedPart("xl/media/image1.png", picture),
      ]),
      "xl/media/image1.png",
      Array.from({ length: 99 }, (_, i) => `xl/media/image${i + 2}.png`)
    );

    const err = await rejection(readWorkbookBuffer(file("aliased.xlsx", aliased)));
    expect(err.code).toBe("unexpected_content");
    expect(err.message).toMatch(/shares bytes with another entry/);
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
    // Not left to the reader's own diagnosis: handing on every guard parse
    // failure would be a hole, because "the guard could not parse it"
    // includes "64 junk bytes in front of a bomb", which JSZip opens anyway.
    // Fail closed.
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
    // bytes in front the central directory does not parse; handed to exceljs
    // anyway, its JSZip skips the prefix and inflates it (measured: 989 MB RSS
    // from a 465 KB file).
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

describe("relationship and content-types parts are held to the per-part XML limit", () => {
  // A 4 MiB cap refused real link-heavy documents: a catalogue with 25 000
  // hyperlinks has a 5.1 MB relationship part. The filter is one forward pass,
  // so the part is held to the same 64 MiB as any other Office XML part.
  const link = (i: number) =>
    `<Relationship Id="rId${i + 10}" Type="${REL_HYPERLINK}" Target="https://intranet.example.com/catalogue/products/item-${String(i).padStart(6, "0")}" TargetMode="External"/>`;

  function linkHeavyDocx(count: number): Buffer {
    return docxWith({
      documentRels: relationships(Array.from({ length: count }, (_, i) => link(i)).join("")),
    });
  }

  it("prepares a document with 25 000 hyperlinks (a 5 MB relationship part), cutting every one", async () => {
    const docx = linkHeavyDocx(25_000);
    const rels = readZipEntries(docx).find((e) => e.name === "word/_rels/document.xml.rels")!;
    expect(rels.uncompressedSize).toBeGreaterThan(5_000_000);

    const prepared = await prepareOfficeSource(file("catalogue.docx", docx));
    expect(prepared.relationshipsRemoved).toBe(25_000);
  });

  it("filters a relationship part near the 64 MiB limit in bounded time", async () => {
    const docx = linkHeavyDocx(320_000);
    const rels = readZipEntries(docx).find((e) => e.name === "word/_rels/document.xml.rels")!;
    expect(rels.uncompressedSize).toBeGreaterThan(60 * MiB);
    const started = Date.now();
    const prepared = await prepareOfficeSource(file("links.docx", docx));
    expect(prepared.relationshipsRemoved).toBe(320_000);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it("still refuses a relationship part past it", async () => {
    const docx = linkHeavyDocx(330_000);
    const rels = readZipEntries(docx).find((e) => e.name === "word/_rels/document.xml.rels")!;
    expect(rels.uncompressedSize).toBeGreaterThan(64 * MiB);
    expect((await rejection(prepareOfficeSource(file("too-many.docx", docx)))).code).toBe(
      "too_large"
    );
  }, 60_000);

  it("reads a content-types part over 4 MiB", async () => {
    const overrides = Array.from(
      { length: 40_000 },
      (_, i) =>
        `<Override PartName="/word/unused${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`
    ).join("");
    const docx = replaceEntry(
      docxWith({ documentRels: relationships() }),
      "[Content_Types].xml",
      deflatedPart(
        "[Content_Types].xml",
        Buffer.from(
          `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${overrides}</Types>`
        )
      )
    );
    expect(
      readZipEntries(docx).find((e) => e.name === "[Content_Types].xml")!.uncompressedSize
    ).toBeGreaterThan(4 * MiB);
    await expect(prepareOfficeSource(file("types.docx", docx))).resolves.toBeDefined();
  });
});

describe("readWorkbookBuffer — one sheet part is capped", () => {
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

  // The cap is for what exceljs PARSES. It copies a
  // picture under `xl/media/` as a Buffer and builds nothing from it, so a
  // two-row price list with one 17 MB product photo is an ordinary workbook.
  // Every other part it decodes to a string first — including parts it then
  // ignores — so those keep the cap, wherever they sit.
  /** `bytes` that do not compress, behind a PNG signature: a photo, as far as the archive can tell. */
  const photo = (bytes: number) =>
    Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(bytes - 8)]);

  async function workbookWith(extra: ZipPart): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Prices").addRows([
      ["Item", "Price"],
      ["Widget", 3],
    ]);
    const base = Buffer.from(await wb.xlsx.writeBuffer());
    return assembleZip([...readZipEntries(base).map((entry) => rawPart(base, entry)), extra]);
  }

  it("reads a workbook whose picture is past the part cap: exceljs copies a picture, it does not parse it", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Prices");
    sheet.addRows([
      ["Item", "Price"],
      ["Widget", 3],
    ]);
    const image = wb.addImage({
      buffer: photo(XLSX_MAX_PART_BYTES + MiB) as unknown as ExcelJS.Buffer,
      extension: "png",
    });
    sheet.addImage(image, "D2:H10");
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());

    await expect(readWorkbookBuffer(file("photo.xlsx", xlsx))).resolves.toBeInstanceOf(Buffer);
  });

  it.each([
    [
      "a part outside xl/media, which exceljs decodes to a string",
      "xl/printerSettings/printerSettings1.bin",
    ],
    [
      "a part under xl/media whose name an exceljs parser also matches",
      "xl/media/xl/drawings/drawing9.xml",
    ],
  ])("still caps %s", async (_, name) => {
    const xlsx = await workbookWith(deflatedPart(name, photo(XLSX_MAX_PART_BYTES + MiB)));
    const err = await rejection(readWorkbookBuffer(file("odd.xlsx", xlsx)));
    expect(err.code).toBe("too_large");
    expect(err.message).toContain(name);
    expect(err.message).toContain(`${XLSX_MAX_PART_BYTES}-byte limit`);
  });

  it("caps a picture at the ceiling every workbook entry has", async () => {
    // Declared, not built: refused from the central directory alone.
    const xlsx = await workbookWith({
      ...deflatedPart("xl/media/image9.png", Buffer.alloc(64)),
      uncompressedSize: XLSX_MAX_ENTRY_BYTES + 1,
    });
    const err = await rejection(readWorkbookBuffer(file("huge-photo.xlsx", xlsx)));
    expect(err.code).toBe("too_large");
    expect(err.message).toContain("xl/media/image9.png");
    expect(err.message).toContain(`${XLSX_MAX_ENTRY_BYTES}-byte limit for one entry`);
  });
});

describe("readGuardedDocx", () => {
  it("returns a verified copy of an ordinary document", async () => {
    const docx = docxWith({ text: "Quarterly figures", documentRels: relationships() });
    const copy = await readGuardedDocx(file("a.docx", docx));
    expect(partsOf(copy)).toEqual(partsOf(docx));
  });

  it("returns a document whose one picture is far larger than any part mammoth parses", async () => {
    // mammoth never reads a picture, so no ceiling holds one back: a Word
    // file carrying a 40 MiB scan is still checked by the word count.
    const scan = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(40 * MiB)]);
    const docx = docxWith({
      documentRels: relationships(
        `<Relationship Id="rId9" Type="${REL_IMAGE}" Target="media/scan.png"/>`
      ),
      parts: { "word/media/scan.png": scan },
    });
    const copy = await readGuardedDocx(file("scan.docx", docx));
    const picture = readZipEntries(copy).find((entry) => entry.name === "word/media/scan.png");
    expect(picture?.uncompressedSize).toBe(scan.length);
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

describe("what a reader resolves differently is refused, not predicted", () => {
  // The preflight reads relationship parts and part names with its own small
  // scanner; mammoth (xmldom + JSZip) and LibreOffice read them with theirs.
  // Where the two can disagree — a prefixed attribute xmldom keys by its local
  // name, a part name JSZip resolves — the package is refused. No Office
  // writer produces either.
  const REL_DOC = relType("officeDocument");

  it.each([
    [
      "a prefixed Type",
      `<Relationship Id="rId9" Type="${REL_IMAGE}" q:Type="${relType("styles")}" Target="media/p.png"/>`,
    ],
    [
      "a prefixed Target",
      `<Relationship Id="rId9" Type="${relType("styles")}" Target="styles.xml" q:Target="media/p.png"/>`,
    ],
    [
      "a prefix bound to nothing",
      `<Relationship xmlns:q="" Id="rId9" Type="${REL_IMAGE}" q:Type="${relType("styles")}" Target="media/p.png"/>`,
    ],
    [
      "a prefixed TargetMode",
      `<Relationship Id="rId9" Type="${REL_IMAGE}" Target="media/p.png" q:TargetMode="External"/>`,
    ],
  ])("refuses a relationship carrying %s", async (_, relationship) => {
    const docx = docxWith({
      documentRels: relationships(relationship),
      parts: { "word/media/p.png": PNG_1X1, "word/styles.xml": ooxmlPart("w:styles") },
    });
    const err = await rejection(prepareOfficeSource(file("prefixed.docx", docx)));
    expect(err.code).toBe("unexpected_content");
  });

  it("still converts a relationship that only declares a namespace", async () => {
    const docx = docxWith({
      documentRels: relationships(
        `<Relationship xmlns:q="urn:x" Id="rId9" Type="${REL_IMAGE}" Target="media/p.png"/>`
      ),
      parts: { "word/media/p.png": PNG_1X1 },
    });
    expect((await prepareOfficeSource(file("ns.docx", docx))).relationshipsRemoved).toBe(0);
  });

  it.each([
    ["word/./document.xml"],
    ["word/_rels/document.xml.rels/."],
    ["word/x/../styles.xml"],
    ["/word/styles.xml"],
    ["word\\styles.xml"],
    ["word//styles.xml"],
  ])("refuses a package with a part named %s", async (name) => {
    const docx = docxWith({
      documentRels: relationships(),
      parts: { [name]: ooxmlPart("w:styles") },
    });
    const prepared = await rejection(prepareOfficeSource(file("dots.docx", docx)));
    expect(prepared.code).toBe("unexpected_content");
    const oracle = await rejection(readGuardedDocx(file("dots-oracle.docx", docx)));
    expect(oracle.code).toBe("unexpected_content");
  });

  it("refuses the document's relationships under a name JSZip resolves", async () => {
    // LibreOffice converts the decoy; mammoth reads `word/_rels/document.xml.rels/.`
    // as the document's relationships, whose styles relationship sends it to
    // a .png the markup count left out.
    const docx = zipOf({
      "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`,
      "_rels/.rels": relationships(
        `<Relationship Id="rId1" Type="${REL_DOC}" Target="word/document.xml"/><Relationship Id="rId2" Type="${REL_IMAGE}" Target="word/document.png"/>`
      ),
      "word/document.xml": ooxmlPart("w:document"),
      "word/_rels/document.xml.rels/.": relationships(
        `<Relationship Id="rId9" Type="${relType("styles")}" Target="document.png"/>`
      ),
      "word/document.png": Buffer.concat([PNG_1X1, Buffer.from("<w:document/>")]),
    });
    expect((await rejection(readGuardedDocx(file("web3.docx", docx)))).code).toBe(
      "unexpected_content"
    );
    expect((await rejection(prepareOfficeSource(file("web3-convert.docx", docx)))).code).toBe(
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

describe("sanitizeOoxmlPackage — relationship allow-list", () => {
  // A relationship being INTERNAL is not enough. An internal aFChunk to an
  // embedded HTML part makes LibreOffice import that HTML, which resolves
  // `<img src="file:///…">` even under the locked profile: local PDF/SVG text
  // landed in the indexed PDF, local PNGs were embedded. An internal SVG
  // picture with an `<image href="file:///…">` does the same. So what stays is
  // what rendering text and layout needs, pointing at parts that are what the
  // relationship says they are; everything else is cut, and the few things
  // that would lose real content by being cut are refused instead.
  const W_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const W_NS = `xmlns:w="${W_MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

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
    // `altChunksRemoved` counts the altChunks cut (they are cut rather than
    // refused); a clean deck has none.
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

  // An altChunk is cut, not a reason to refuse the whole package. Refusing
  // would throw away every word of an otherwise ordinary document over one
  // embedded chunk; cutting the chunk —
  // relationship AND element — keeps the rest searchable and still never lets
  // a second import filter see it. The operator log says what was dropped.
  function partAfter(pkg: Buffer, name: string): string {
    const out = sanitizeOoxmlPackage(pkg);
    const entry = readZipEntries(out.data).find((e) => e.name === name)!;
    return inflatePart(out.data, entry, 1 << 20).toString("utf8");
  }

  it("cuts an altChunk relationship and its element, and keeps the rest of the document", async () => {
    // The vector: an embedded HTML part whose <img src="file://…">
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

  // LibreOffice 26.2 imported `<ä:altChunk xmlns:ä="…/wordprocessingml/2006/main" r:id="…"/>`
  // from a staged copy: a prefix is any XML name, not only an ASCII one.
  it.each([
    ["self-closing", `<ä:altChunk xmlns:ä="${W_MAIN}" r:id="rId5"/>`],
    [
      "with children",
      `<ä:altChunk xmlns:ä="${W_MAIN}" r:id="rId5"><ä:altChunkPr><ä:matchSrc/></ä:altChunkPr></ä:altChunk>`,
    ],
    ["in a script with no Latin letters", `<文書:altChunk xmlns:文書="${W_MAIN}" r:id="rId5"/>`],
  ])("cuts an altChunk whose prefix is spelled with non-ASCII letters (%s)", (_, element) => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", REL_IMAGE, "media/image1.png")),
      body: element,
      parts: { "word/media/image1.png": PNG_1X1 },
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.altChunksRemoved).toBe(1);
    const document = partAfter(pkg, "word/document.xml");
    expect(document).not.toMatch(/altChunk/);
    expect(document).toContain("Hello canary document");
  });

  it("reads a part whose root element has a non-ASCII prefix, and cuts its altChunk", () => {
    const pkg = zipOf({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": relationships(rel("rId1", relType("officeDocument"), "word/document.xml")),
      "word/_rels/document.xml.rels": relationships(),
      "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><ä:document xmlns:ä="${W_MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><ä:body><ä:p><ä:r><ä:t>Words</ä:t></ä:r></ä:p><ä:altChunk r:id="rId5"/></ä:body></ä:document>`,
    });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.altChunksRemoved).toBe(1);
    expect(partAfter(pkg, "word/document.xml")).not.toMatch(/altChunk/);
  });

  it.each([
    ["an altChunk", `<w:alt<w:altChunk r:id="rId5"/>Chunk r:id="rId5"/>`],
    ["a DOCTYPE", `<!DOC<w:altChunk r:id="rId5"/>TYPE w:document>`],
    ["an SVG element", `<s<w:altChunk r:id="rId5"/>vg xmlns="http://www.w3.org/2000/svg"/>`],
  ])(
    "refuses a part where cutting an altChunk would join the text around it into %s",
    (_, body) => {
      // Measured for the first: LibreOffice 26.2 imported the altChunk the cut
      // spliced together, from the staged copy. What a cut leaves is held to
      // the same rules as what came in.
      const pkg = docxWith({
        documentRels: relationships(rel("rId5", REL_IMAGE, "media/image1.png")),
        body,
        parts: { "word/media/image1.png": PNG_1X1 },
      });
      expect(refusedWith(pkg).code).toBe("unexpected_content");
    }
  );

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

  it.each([
    ["a newline", "media/x\ny.png"],
    ["a tab", "media/x\ty.png"],
    ["a NEL", "media/x\u0085y.png"],
    ["a C1 control character", "media/x\u0090y.png"],
    ["a line separator", "media/x\u2028y.png"],
  ])(
    "cuts a relationship whose target holds %s, even when a part of exactly that name exists: a parser may read it as another name",
    (_, target) => {
      // Attribute-value normalisation turns a newline into a space, and
      // @xmldom/xmldom does the same to NEL and U+2028; the part vetted under
      // the raw name need not be the one a reader opens. A regression pin
      // rather than a fix: `resolveTarget` already gives up on whitespace and
      // C0 controls, and reads a relationship part as latin1, so a non-ASCII
      // target never names an entry and is cut as missing. The plugin's
      // markup count had no such rule and was the hole (docx-zip-guard.ts).
      const pkg = docxWith({
        documentRels: relationships(rel("rId5", REL_IMAGE, target)),
        parts: { [`word/${target}`]: PNG_1X1, "word/media/x y.png": PNG_1X1 },
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

describe("no regex on file bytes is super-linear", () => {
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

  it("refuses a package whose single-token relationship is deflated to a few hundred bytes — in bounded time", async () => {
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

  it.each([
    ["one 4 MiB name", `<${"a".repeat(BIG)}/>`],
    ["4 MiB of names that never end", "<a".repeat(BIG / 2)],
  ])("reads the element names in an Office part of %s in bounded time", (_, body) => {
    // An element name is read up to the next `<` at most, so no character is
    // read from more than one place.
    const pkg = docxWith({ documentRels: relationships(), body });
    const started = Date.now();
    expect(sanitizeOoxmlPackage(pkg).altChunksRemoved).toBe(0);
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

describe("a kept part is vetted by what it IS, not by its relationship's Type", () => {
  // LibreOffice resolves `r:embed` by Id and never looks at the Type, then
  // detects a picture's format from its bytes. So a part kept as a FONT, or
  // as Office XML, is drawn as an SVG if its bytes say SVG — and an SVG reads
  // local files under the locked profile. Measured against LibreOffice 26.2,
  // every vector below puts a local file's text into the PDF when it is not
  // cut.
  const gzip = (text: string) => gzipSync(Buffer.from(text));
  const reachingSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200"><image width="400" height="60" xlink:href="file:///etc/hostname"/></svg>`;

  function cutCount(relType_: string, target: string, part: string | Buffer): number {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", relType_, target)),
      parts: { [`word/${target}`]: part },
    });
    return sanitizeOoxmlPackage(pkg).removed;
  }

  /**
   * Relationships cut from a .docx whose FONT TABLE embeds `part` — where
   * fonts live, so what is judged is the font's bytes, not its place. (A
   * font relationship anywhere else is cut whatever it points at:
   * office-preflight.reader-agreement.test.ts.)
   */
  function fontCut(
    part: Buffer,
    target = "fonts/font1.odttf",
    fontKey: string | null = FONT_KEY
  ): number {
    const key = fontKey ? ` w:fontKey="${fontKey}"` : "";
    const pkg = docxWith({
      documentRels: relationships(rel("rId9", relType("fontTable"), "fontTable.xml")),
      parts: {
        "word/fontTable.xml": `<?xml version="1.0" encoding="UTF-8"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:font w:name="F"><w:embedRegular r:id="rIdF"${key}/></w:font></w:fonts>`,
        "word/_rels/fontTable.xml.rels": relationships(rel("rIdF", relType("font"), target)),
        [`word/${target}`]: part,
      },
    });
    return sanitizeOoxmlPackage(pkg).removed;
  }
  const FONT_KEY = "{62E79491-959F-41E9-B76B-6B32631DEA5C}";

  function refused(relType_: string, target: string, part: string | Buffer) {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", relType_, target)),
      parts: { [`word/${target}`]: part },
    });
    expect(() => sanitizeOoxmlPackage(pkg)).toThrow(OfficeFileRejectedError);
  }

  it("cuts a font that is a gzipped SVG (svgz)", () => {
    expect(fontCut(gzip(reachingSvg))).toBe(1);
  });

  it("cuts a font whose first kilobytes carry an SVG element behind binary junk", () => {
    const part = Buffer.concat([Buffer.from([0, 1, 2, 3, 0xff, 0xfe]), Buffer.from(reachingSvg)]);
    expect(fontCut(part)).toBe(1);
  });

  it("keeps an ordinary obfuscated font: a TrueType font whose first 32 bytes its key scrambles", () => {
    // ECMA-376 §17.8.1: the GUID's 16 bytes, last first, XORed over the
    // font's first 32 twice over.
    const key = Buffer.from(FONT_KEY.replace(/[{}-]/g, ""), "hex").reverse();
    const font = Buffer.alloc(2048);
    for (let i = 0; i < font.length; i++) font[i] = (i * 131 + 7) & 0xff;
    Buffer.from("00010000", "hex").copy(font);
    for (let i = 0; i < 32; i++) font[i] ^= key[i % 16];
    expect(fontCut(font)).toBe(0);
  });

  it("cuts an 'obfuscated font' that its key does not turn into a font", () => {
    const font = Buffer.alloc(2048);
    for (let i = 0; i < font.length; i++) font[i] = (i * 131 + 7) & 0xff;
    expect(fontCut(font)).toBe(1);
  });

  // A font's id can be borrowed by anything that resolves an `r:id` without
  // checking the Type — an altChunk does, and LibreOffice 26.2 imported a
  // "font" that was UTF-16 HTML and drew the local file its `<img>` named.
  // An import filter's detection reads past a byte-order mark, so this does.
  const page = `<html><body><img src="file:///etc/hostname"></body></html>`;
  const utf16be = (text: string) => Buffer.from(text, "utf16le").swap16();
  const utf32le = (text: string) => {
    const out = Buffer.alloc(text.length * 4);
    for (let i = 0; i < text.length; i++) out.writeUInt32LE(text.charCodeAt(i), i * 4);
    return out;
  };
  it.each([
    ["UTF-16LE with a byte-order mark", Buffer.from(`﻿${page}`, "utf16le")],
    ["UTF-16BE with a byte-order mark", utf16be(`﻿${page}`)],
    ["UTF-32LE with a byte-order mark", utf32le(`﻿${page}`)],
    ["UTF-16LE without one", Buffer.from(page, "utf16le")],
    ["UTF-16BE without one", utf16be(page)],
  ])("cuts a font that is an HTML page in %s", (_, bytes) => {
    expect(fontCut(bytes)).toBe(1);
  });

  it.each([
    ["TrueType", "0001000000100100000400004744454600"],
    ["OpenType", "4f54544f000c0080000300404346462000"],
  ])("keeps a plain %s font: its NULs are not text", (_, hex) => {
    const font = Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(1024, 0x3c)]);
    // No key: a plain font is read as it is.
    expect(fontCut(font, "fonts/font1.ttf", null)).toBe(0);
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
    [
      "an Office root with an SVG element whose prefix is non-ASCII",
      `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><ä:svg xmlns:ä="http://www.w3.org/2000/svg"/></w:hdr>`,
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

  it.each(["foreignObject", "s:foreignObject", "ä:foreignObject"])(
    "cuts an SVG picture with a foreignObject (<%s>): an HTML island can carry its own references",
    (qname) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:ä="http://www.w3.org/2000/svg"><${qname}><img xmlns="http://www.w3.org/1999/xhtml" src="file:///etc/hostname"/></${qname}></svg>`;
      expect(cutCount(REL_IMAGE, "media/image1.svg", svg)).toBe(1);
    }
  );

  it("cuts a PNG-looking picture whose first kilobytes also carry an SVG element", () => {
    const part = Buffer.concat([PNG_1X1.subarray(0, 16), Buffer.from(reachingSvg)]);
    expect(cutCount(REL_IMAGE, "media/image1.png", part)).toBe(1);
  });
});

describe("RTF named .doc", () => {
  // An RTF file named .doc is accepted (Word writes these), and LibreOffice
  // draws an RTF `\pict` by sniffing its bytes — an SVG inside one read a
  // local file under the locked profile. So the
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

describe("an Office XML part is read as UTF-8, and one a parser would decode otherwise is refused", () => {
  // Every scan in the preflight reads a part's bytes one character per byte,
  // which is what a parser reads only when the part is UTF-8 (or ASCII):
  // then `<`, `"` and `>` are those bytes and nothing else. A part that
  // DECLARES another encoding is decoded by LibreOffice the way it says. In
  // UTF-7, `<` is `+ADw-`: a document part carrying
  // `+ADw-w:altChunk r:id=+ACI-rIdH+ACI-/+AD4-` holds an altChunk no scan
  // sees — LibreOffice 26.2 imported the header it borrowed as HTML and drew
  // the local files that HTML named.
  const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  const declared = (encoding: string, xml: string) =>
    xml.replace(/encoding="UTF-8"/, `encoding="${encoding}"`);

  function refusedWith(pkg: Buffer): OfficeFileRejectedError {
    try {
      sanitizeOoxmlPackage(pkg);
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeFileRejectedError);
      return err as OfficeFileRejectedError;
    }
    throw new Error("expected the package to be refused");
  }

  /** A document with a header relationship, its parts overridable. */
  const withHeader = (parts: Record<string, string | Buffer> = {}) =>
    docxWith({
      documentRels: relationships(rel("rIdH", relType("header"), "header1.xml")),
      parts: { "word/header1.xml": ooxmlPart("w:hdr"), ...parts },
    });

  it("refuses a UTF-7 document part whose altChunk borrows a kept header's id", async () => {
    const header = `<!-- c --><w:hdr ${W_NS}><html><body><p>chunk</p><img src="file:///etc/hostname"></body></html></w:hdr>`;
    const document = declared(
      "UTF-7",
      documentXml("Body words", undefined, "+ADw-w:altChunk r:id=+ACI-rIdH+ACI-/+AD4-")
    );
    const pkg = withHeader({ "word/header1.xml": header, "word/document.xml": document });

    expect(refusedWith(pkg).code).toBe("unexpected_content");
    const err = await rejection(prepareOfficeSource(file("utf7.docx", pkg)));
    expect(err.message).toMatch(/word\/document\.xml.*UTF-8/);
  });

  it.each(["ISO-8859-1", "UTF-7", "Shift_JIS", "UTF-16", "US-ASCII", "windows-1252"])(
    "refuses a document part that declares %s",
    (encoding) => {
      const pkg = withHeader({
        "word/document.xml": declared(encoding, documentXml("Body words")),
      });
      expect(refusedWith(pkg).code).toBe("unexpected_content");
    }
  );

  it.each(["ISO-8859-1", "UTF-7", "Shift_JIS"])(
    "refuses a relationship part that declares %s",
    (encoding) => {
      const pkg = docxWith({
        documentRels: declared(
          encoding,
          relationships(rel("rIdH", relType("header"), "header1.xml"))
        ),
        parts: { "word/header1.xml": ooxmlPart("w:hdr") },
      });
      expect(refusedWith(pkg).code).toBe("unexpected_content");
    }
  );

  it.each(["ISO-8859-1", "UTF-7", "Shift_JIS"])(
    "refuses a kept header that declares %s",
    (encoding) => {
      const pkg = withHeader({ "word/header1.xml": declared(encoding, ooxmlPart("w:hdr")) });
      expect(refusedWith(pkg).code).toBe("unexpected_content");
    }
  );

  it("refuses a content-types part that declares UTF-7", () => {
    const pkg = withHeader({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-7"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    });
    expect(refusedWith(pkg).code).toBe("unexpected_content");
  });

  it.each([
    ["an overlong `<`", [0xc0, 0xbc]],
    ["a lone continuation byte", [0x80]],
    ["a truncated three-byte sequence", [0xe2, 0x82]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["a code point past U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
  ])("refuses a document part holding %s, which is not UTF-8", (_, bytes) => {
    const [head, tail] = documentXml("Body XYZ words").split("XYZ");
    const pkg = withHeader({
      "word/document.xml": Buffer.concat([
        Buffer.from(head),
        Buffer.from(bytes),
        Buffer.from(tail),
      ]),
    });
    expect(refusedWith(pkg).code).toBe("unexpected_content");
  });

  it("refuses a relationship part holding bytes that are not UTF-8", () => {
    const pkg = withHeader({
      "word/_rels/document.xml.rels": Buffer.concat([
        Buffer.from(relationships(rel("rIdH", relType("header"), "header1.xml"))),
        Buffer.from([0xff]),
      ]),
    });
    expect(refusedWith(pkg).code).toBe("unexpected_content");
  });

  it("refuses a declaration that names its encoding twice", () => {
    const pkg = withHeader({
      "word/header1.xml": ooxmlPart("w:hdr").replace(
        'encoding="UTF-8"',
        'encoding="UTF-8" encoding="UTF-7"'
      ),
    });
    expect(refusedWith(pkg).code).toBe("unexpected_content");
  });

  const hdr = `<w:hdr ${W_NS}><w:p><w:r><w:t>Kopfzeile – Größe</w:t></w:r></w:p></w:hdr>`;
  it.each([
    ["a declaration and a byte-order mark", `﻿<?xml version="1.0" encoding="UTF-8"?>${hdr}`],
    [
      "a declaration, no byte-order mark",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${hdr}`,
    ],
    [
      "a lower-case, single-quoted encoding",
      `<?xml version='1.0' encoding='utf-8' standalone='yes'?>${hdr}`,
    ],
    ["the `utf8` spelling", `<?xml version="1.0" encoding="utf8"?>${hdr}`],
    ["a declaration that names no encoding", `<?xml version="1.0" standalone="yes"?>${hdr}`],
    ["a byte-order mark and no declaration", `﻿${hdr}`],
    ["neither", hdr],
  ])("keeps a UTF-8 part with %s", (_, text) => {
    const pkg = withHeader({ "word/header1.xml": Buffer.from(text, "utf8") });
    const out = sanitizeOoxmlPackage(pkg);
    expect(out.removed).toBe(0);
    expect(out.data).toBe(pkg);
  });

  it("cuts an SVG picture declared UTF-7, whose quotes no scan for a reference sees", () => {
    // `href=+ACI-file:///…+ACI-` is `href="file:///…"` to a UTF-7 decoder.
    const svg = `<?xml version="1.0" encoding="UTF-7"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image width="400" height="60" xlink:href=+ACI-file:///etc/hostname+ACI-/></svg>`;
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", REL_IMAGE, "media/image1.svg")),
      parts: { "word/media/image1.svg": svg },
    });
    expect(sanitizeOoxmlPackage(pkg).removed).toBe(1);
  });

  it("keeps a self-contained UTF-8 SVG picture, declared or not", () => {
    for (const head of ["", `<?xml version="1.0" encoding="UTF-8"?>`, "﻿"]) {
      const svg = `${head}<svg xmlns="http://www.w3.org/2000/svg"><text>Größe</text></svg>`;
      const pkg = docxWith({
        documentRels: relationships(rel("rId5", REL_IMAGE, "media/image1.svg")),
        parts: { "word/media/image1.svg": Buffer.from(svg, "utf8") },
      });
      expect(sanitizeOoxmlPackage(pkg).removed, JSON.stringify(head)).toBe(0);
    }
  });
});

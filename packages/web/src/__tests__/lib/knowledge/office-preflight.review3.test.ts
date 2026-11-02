/**
 * The third review of PR #1243 on the knowledge base's Office preflight: one
 * false refusal of ordinary files, three ways past it, and two ways to make
 * the web process inflate or grind for minutes. Each test here was red before
 * the change it pins.
 *
 *   1. `<asvg:svgBlip>` — what Office 365 and LibreOffice write for EVERY SVG
 *      picture — was read as an `<svg` element, so every such document was
 *      refused outright.
 *   2. RTF `\binN` with N past 2^31: the sanitizer skipped to the end of the
 *      file, LibreOffice overflowed N to 0 and drew the hidden `\pict`.
 *   3. EMF/WMF pictures pass on their magic bytes, but an EMF+ image object
 *      (or an EMF inside a WMF) carries another picture LibreOffice detects by
 *      ITS bytes — an SVG that read a local file into the PDF.
 *   4. A number format spelled `&#91;` decodes to `[` in exceljs's parser,
 *      past a check that counted literal brackets.
 *   5. One Office XML part, however large, was inflated whole into the web
 *      heap; mammoth builds a DOM from it on top.
 *
 * Deterministic, no LibreOffice; the matching canaries are in
 * `office-convert.canary.libreoffice.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";

import {
  prepareOfficeSource,
  readGuardedDocx,
  readWorkbookBuffer,
  sanitizeOoxmlPackage,
} from "@/lib/knowledge/office-preflight";
import { OfficeFileRejectedError } from "@/lib/knowledge/office-formats";
import {
  assembleZip,
  crc32,
  deflatedPart,
  inflatePart,
  rawPart,
  readZipEntries,
} from "@/lib/knowledge/office-zip";
import {
  docxWith,
  peakRss,
  PNG_1X1,
  REL_IMAGE,
  relationships,
  relType,
  truthfulSpacesEntry,
} from "@/test-helpers/office-zip";
import {
  EMF_PLUS_DRAW_IMAGE,
  EMF_RECTANGLE,
  GDI_PUBLIC_ID,
  emf,
  emfComment,
  emfPlusBrushObject,
  emfPlusComment,
  emfPlusImageObject,
  emfPlusPenObject,
  emfRecord,
  paddingComment,
  wmf,
  wmfEmbeddedEmf,
  wmfEscape,
  WMF_RECTANGLE,
} from "@/test-helpers/metafile";

const MiB = 1024 * 1024;
const FIXTURES = join(__dirname, "../../fixtures/kb/office");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinchy-kb-preflight-r3-"));
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

const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;

/** An SVG that draws a local file — what every vector below smuggles. */
const REACHING_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200"><image width="400" height="60" xlink:href="file:///etc/hostname"/></svg>`
);

describe("finding 1: an SVG picture written by Office or LibreOffice is converted, not refused", () => {
  // Both files were written by LibreOffice 26.2 from a flat ODF holding one
  // SVG icon and a line of text — the shape Office 365 writes for every SVG
  // picture and every PowerPoint Icon: a PNG fallback in `a:blip` and the SVG
  // in `<asvg:svgBlip>`. No personal data; the metadata is empty.
  it.each([
    ["svg-icon-letter.docx", "word/document.xml"],
    ["svg-icon-deck.pptx", "ppt/slides/slide1.xml"],
  ])("converts %s with both pictures kept", async (name, partWithSvgBlip) => {
    const bytes = readFileSync(join(FIXTURES, name));
    expect(
      readZipEntries(bytes).some((entry) => entry.name === partWithSvgBlip),
      "fixture has the part"
    ).toBe(true);

    const prepared = await prepareOfficeSource(file(name, bytes));

    expect(prepared.relationshipsRemoved).toBe(0);
    // A fresh archive (the verified copy), holding exactly the same parts.
    expect(partsOf(prepared.data)).toEqual(partsOf(bytes));
  });

  it.each([
    [
      "asvg:svgBlip",
      `<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId3"/>`,
    ],
    [
      "a14:svgThing",
      `<a14:svgThing xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"/>`,
    ],
  ])("keeps an Office part holding a `%s` element", (_, element) => {
    const pkg = docxWith({ documentRels: relationships(), body: `<w:p>${element}</w:p>` });
    expect(sanitizeOoxmlPackage(pkg).removed).toBe(0);
  });

  it.each([
    ["an svg element in another namespace prefix", `<x:svg xmlns:x="http://www.w3.org/2000/svg"/>`],
    ["an svg element with attributes", `<x:svg width="1"/>`],
    ["a bare svg element", `<svg/>`],
    // LibreOffice's detection looks for the BYTES `<svg`, not for an element
    // named svg: `<svgx>` is taken for SVG too.
    ["a bare <svg prefix of a longer name", `<svgx/>`],
  ])("still refuses an Office part holding %s", (_, element) => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", relType("header"), "header1.xml")),
      parts: {
        "word/header1.xml": `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${element}</w:hdr>`,
      },
    });
    expect(() => sanitizeOoxmlPackage(pkg)).toThrow(OfficeFileRejectedError);
  });
});

describe("finding 2: RTF `\\bin` that the sanitizer and LibreOffice could read differently is refused", () => {
  const svgHex = REACHING_SVG.toString("hex");
  const pict = `{\\pict\\pngblip\\picw400\\pich200 ${svgHex}}`;
  const rtf = (before: string) =>
    `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}}\\pard Body words\\par ${before}${pict}\\par After words\\par }`;

  it.each([
    // The reviewer's s2.doc: 2^31 is past what LibreOffice's 32-bit parameter
    // holds, it reads 0 and draws the picture the sanitizer skipped over.
    ["2^31 in an ignorable destination", "{\\*\\pinchyx\\bin2147483648 X}"],
    ["2^31", "{\\bin2147483648 X}"],
    ["2^32 + 1", "{\\bin4294967297 X}"],
    ["3 000 000 000", "{\\bin3000000000 X}"],
    ["eleven digits", "{\\bin12345678901 X}"],
    ["twenty digits", "{\\bin99999999999999999999 X}"],
    ["more bytes than the file has left", "{\\bin99999999 X}"],
    ["a negative count", "{\\bin-5 X}"],
    // Within the file, but outside any group that is cut: Word writes pictures
    // in hex, and a binary run here is a place the two readers could disagree
    // about where a group ends.
    ["a run outside a cut group", "{\\*\\pinchyx\\bin40 X}"],
    ["a run that swallows the brace before a picture", "{\\bin40 }"],
  ])("refuses `\\bin` with %s", async (_, before) => {
    const err = await rejection(prepareOfficeSource(file("posing.doc", rtf(before))));
    expect(err.code).toBe("unexpected_content");
  });

  it.each([
    ["a non-hex escape before a group", "x\\'{"],
    ["a non-hex escape before an escaped brace", "x\\'\\{"],
    ["an escape cut off by the end of the file", ""],
  ])("refuses %s: `\\'` must be two hex digits", async (_, before) => {
    const body = before === "" ? `{\\rtf1 words \\'4` : rtf(before);
    const err = await rejection(prepareOfficeSource(file("posing.doc", body)));
    expect(err.code).toBe("unexpected_content");
  });

  it("still honours a binary run inside a picture it cuts", async () => {
    const prepared = await prepareOfficeSource(
      file("ok.doc", `{\\rtf1\\ansi Kept {\\pict\\pngblip\\bin4 }}}}${svgHex}} Tail\\par}`)
    );
    const out = prepared.data.toString("latin1");
    expect(out).not.toContain(svgHex);
    expect(out).toContain("Kept");
    expect(out).toContain("Tail");
  });

  it("leaves ordinary RTF with hex escapes untouched", async () => {
    const body = `{\\rtf1\\ansi\\ansicpg1252 Ma\\'dfnahmen f\\'fcr Dom\\'9e\\par}`;
    const prepared = await prepareOfficeSource(file("ok.doc", body));
    expect(prepared.data.toString("latin1")).toBe(body);
  });
});

describe("finding 3: a metafile picture is kept only if it carries no picture of its own", () => {
  function imageCut(bytes: Buffer, target = "media/image1.emf"): number {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", REL_IMAGE, target)),
      parts: { [`word/${target}`]: bytes },
    });
    return sanitizeOoxmlPackage(pkg).removed;
  }

  // The reviewer's emfplus2.docx: an EMF+ image object whose compressed
  // bitmap is an SVG, behind 4 KiB of comment padding so the first kilobytes
  // look like a metafile and nothing else. LibreOffice drew the local file.
  const smuggled = emf(
    paddingComment(4400),
    emfPlusComment(emfPlusImageObject(REACHING_SVG), EMF_PLUS_DRAW_IMAGE),
    EMF_RECTANGLE
  );

  it("cuts an EMF whose EMF+ image object is an SVG behind 4 KiB of padding", () => {
    expect(smuggled.subarray(0, 4096).includes("<svg")).toBe(false);
    expect(imageCut(smuggled)).toBe(1);
  });

  it.each([
    ["a PNG bitmap", emfPlusImageObject(PNG_1X1)],
    ["an embedded metafile", emfPlusImageObject(emf(EMF_RECTANGLE), "metafile")],
    ["a texture-brush", emfPlusBrushObject(2)],
    ["a pen filled by a texture brush", emfPlusPenObject(2)],
  ])("cuts an EMF whose EMF+ records carry %s", (_, record) => {
    expect(imageCut(emf(emfPlusComment(record), EMF_RECTANGLE))).toBe(1);
  });

  it.each([
    ["an embedded EMF or EPS (multiformats)", 0x40000004],
    ["an embedded WMF", 0x80000001],
    ["an unknown public comment", 0x41414141],
  ])("cuts an EMF whose public comment carries %s", (_, kind) => {
    const comment = emfComment(GDI_PUBLIC_ID, Buffer.concat([u32(kind), Buffer.alloc(64)]));
    expect(imageCut(emf(comment))).toBe(1);
  });

  it.each([
    [
      "a record running past the end",
      () => Buffer.concat([emf(), emfRecord(43, Buffer.alloc(8))]).subarray(0, -4),
    ],
    [
      "a record of size zero",
      () => injectAfterHeader(emf(EMF_RECTANGLE), Buffer.from([43, 0, 0, 0, 0, 0, 0, 0])),
    ],
    ["no end-of-file record", () => emf(EMF_RECTANGLE).subarray(0, -20)],
    [
      "an EMF+ record running past its comment",
      () =>
        emf(
          emfComment(0x2b464d45, Buffer.from([0x08, 0x40, 0x00, 0x05, 0xff, 0, 0, 0, 0, 0, 0, 0]))
        ),
    ],
  ])("cuts an EMF it cannot walk: %s", (_, build) => {
    expect(imageCut(build())).toBe(1);
  });

  it("keeps a plain EMF, and one whose EMF+ records only draw shapes", () => {
    expect(imageCut(emf(EMF_RECTANGLE))).toBe(0);
    expect(
      imageCut(
        emf(
          paddingComment(64),
          emfPlusComment(emfPlusBrushObject(0), emfPlusPenObject(0)),
          EMF_RECTANGLE
        )
      )
    ).toBe(0);
  });

  it("keeps a plain WMF, and one carrying a plain EMF — as every WMF LibreOffice and Office write does", () => {
    expect(imageCut(wmf(WMF_RECTANGLE), "media/image1.wmf")).toBe(0);
    expect(
      imageCut(wmf(wmfEmbeddedEmf(emf(EMF_RECTANGLE)), WMF_RECTANGLE), "media/image1.wmf")
    ).toBe(0);
  });

  it.each(["libreoffice-drawing.emf", "libreoffice-drawing.wmf"])(
    "keeps %s — a rectangle, an ellipse, text and a bitmap, as LibreOffice 26.2 writes them",
    (name) => {
      // The WMF carries the whole drawing again as an EMF; a rule that cut
      // every WMF with an embedded EMF would cut every one LibreOffice writes.
      const bytes = readFileSync(join(FIXTURES, name));
      expect(imageCut(bytes, `media/image1.${name.split(".").pop()}`)).toBe(0);
    }
  );

  it("cuts a WMF whose embedded EMF carries a picture: LibreOffice draws that EMF instead", () => {
    expect(imageCut(wmf(wmfEmbeddedEmf(smuggled), WMF_RECTANGLE), "media/image1.wmf")).toBe(1);
  });

  it("cuts a WMF whose embedded EMF is not all there", () => {
    const record = wmfEmbeddedEmf(emf(EMF_RECTANGLE));
    record.writeUInt32LE(record.readUInt32LE(40) + 4, 40); // declares 4 bytes more than it carries
    expect(imageCut(wmf(record, WMF_RECTANGLE), "media/image1.wmf")).toBe(1);
  });

  it("cuts a WMF carrying encapsulated PostScript", () => {
    expect(
      imageCut(wmf(wmfEscape(0x1014, Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n"))), "media/image1.wmf")
    ).toBe(1);
  });

  it("cuts a metafile too large to walk", () => {
    const huge = emf(paddingComment(17 * MiB), EMF_RECTANGLE);
    expect(imageCut(huge)).toBe(1);
  });

  it("cuts a FONT whose bytes are a metafile: `r:embed` draws it by its bytes, whatever its Type", () => {
    const pkg = docxWith({
      documentRels: relationships(rel("rId5", relType("font"), "fonts/font1.odttf")),
      parts: { "word/fonts/font1.odttf": smuggled },
    });
    expect(sanitizeOoxmlPackage(pkg).removed).toBe(1);
  });
});

describe("finding 4: a number format is judged by what the XML parser makes of it", () => {
  function workbook(formatCode: string, cells: number): Buffer {
    const part = (name: string, xml: string) => deflatedPart(name, Buffer.from(xml));
    const col = (i: number) =>
      (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : "") +
      String.fromCharCode(65 + (i % 26));
    let rows = "";
    for (let r = 1; r <= cells / 100; r++) {
      let cs = "";
      for (let c = 0; c < 100; c++) cs += `<c r="${col(c)}${r}" s="1"><v>1</v></c>`;
      rows += `<row r="${r}">${cs}</row>`;
    }
    const ns = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`;
    return assembleZip([
      part(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
      ),
      part("_rels/.rels", relationships(rel("rId1", relType("officeDocument"), "xl/workbook.xml"))),
      part(
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
      ),
      part(
        "xl/_rels/workbook.xml.rels",
        relationships(
          rel("rId1", relType("worksheet"), "worksheets/sheet1.xml"),
          rel("rId2", relType("styles"), "styles.xml")
        )
      ),
      part(
        "xl/styles.xml",
        `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${ns}><numFmts count="1"><numFmt numFmtId="164" formatCode="${formatCode}"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`
      ),
      part(
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData>${rows}</sheetData></worksheet>`
      ),
    ]);
  }

  it.each([
    ["decimal references", "0" + "&#91;".repeat(204)],
    // Each spelled short enough that its RAW length passes the length rule:
    // only decoding shows what exceljs will see.
    ["hex references", "0" + "&#x5b;".repeat(150)],
    ["zero-padded references", "0" + "&#00091;".repeat(120)],
    // Leading zeros are legal, so a reference has no fixed length: one read
    // only up to some cap would see none of these.
    ["references padded past any fixed length", "0" + `&#${"0".repeat(20)}91;`.repeat(100)],
    ["a mix after a closed bracket", "[Red]0" + "&#91;&#x5B;".repeat(60)],
  ])("refuses a format whose unclosed brackets are spelled as %s — fast", async (_, formatCode) => {
    // The reviewer's xl.mts: 200 000 styled cells with this format took
    // exceljs 4.4 s to load, and minutes at the size limit.
    const started = Date.now();
    const err = await rejection(
      readWorkbookBuffer(file("brackets.xlsx", workbook(formatCode, 200_000)))
    );
    expect(err.code).toBe("unexpected_content");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("refuses a format whose DECODED length is past the limit, however it is spelled", async () => {
    const formatCode = "&#48;".repeat(1100);
    const err = await rejection(readWorkbookBuffer(file("long.xlsx", workbook(formatCode, 100))));
    expect(err.code).toBe("unexpected_content");
  });

  it("reads a format whose entity spelling is long but whose decoded text is short", async () => {
    // 1 041 characters as written, 241 as parsed — within Excel's 255.
    const formatCode = "0" + "&quot;x&quot;".repeat(80);
    const buffer = await readWorkbookBuffer(file("quoted.xlsx", workbook(formatCode, 100)));
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("still reads an ordinary format that needs entities, and loads it", async () => {
    const formatCode = "#,##0.00&quot; €&quot;;[Red]-#,##0.00&quot; €&quot;";
    const buffer = await readWorkbookBuffer(file("ok.xlsx", workbook(formatCode, 100)));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.getWorksheet("S")!.getCell("A1").numFmt).toBe('#,##0.00" €";[Red]-#,##0.00" €"');
  });
});

describe("finding 5: no single Office XML part is inflated whole past a ceiling", () => {
  const DOC_HEAD = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>`;
  const DOC_TAIL = `</w:t></w:r></w:p></w:body></w:document>`;

  /**
   * A .docx whose document part is `xmlBytes` long and true about it, plus a
   * stored pad of random bytes so the archive stays under the ratio rule —
   * the reviewer's big.mts, which ran the preflight to 1.3 GB RSS.
   */
  function docxWithDocumentOf(xmlBytes: number): Buffer {
    const base = docxWith({ documentRels: relationships() });
    const document = truthfulSpacesEntry("word/document.xml", {
      head: DOC_HEAD,
      tail: DOC_TAIL,
      spaceBytes: xmlBytes - DOC_HEAD.length - DOC_TAIL.length,
    });
    const pad = randomBytes(Math.ceil(xmlBytes / 150));
    return assembleZip([
      ...readZipEntries(base)
        .filter((entry) => entry.name !== "word/document.xml")
        .map((entry) => rawPart(base, entry)),
      document,
      {
        name: "word/media/pad.bin",
        method: 0,
        flags: 0,
        crc32: crc32(pad),
        uncompressedSize: pad.length,
        data: pad,
      },
    ]);
  }

  it("refuses a document part over 64 MiB in the conversion path, without holding it", async () => {
    const path = file("big.docx", docxWithDocumentOf(65 * MiB));
    const before = peakRss();
    const err = await rejection(prepareOfficeSource(path));
    expect(err.code).toBe("too_large");
    expect(peakRss() - before).toBeLessThan(48 * MiB);
  });

  it("refuses a document part over 32 MiB for mammoth, without holding it", async () => {
    const path = file("big.docx", docxWithDocumentOf(33 * MiB));
    const before = peakRss();
    const err = await rejection(readGuardedDocx(path));
    expect(err.code).toBe("too_large");
    expect(peakRss() - before).toBeLessThan(48 * MiB);
  });

  it("refuses a workbook whose styles part is over 64 MiB before reading its formats", async () => {
    const xlsx = docxWithDocumentOf(1 * MiB);
    const styles = truthfulSpacesEntry("xl/styles.xml", {
      head: `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
      tail: `</styleSheet>`,
      spaceBytes: 65 * MiB,
    });
    const pad = randomBytes(Math.ceil((65 * MiB) / 150));
    const archive = assembleZip([
      ...readZipEntries(xlsx).map((entry) => rawPart(xlsx, entry)),
      styles,
      {
        name: "xl/media/pad.bin",
        method: 0,
        flags: 0,
        crc32: crc32(pad),
        uncompressedSize: pad.length,
        data: pad,
      },
    ]);
    const err = await rejection(readWorkbookBuffer(file("styles.xlsx", archive)));
    expect(err.code).toBe("too_large");
  });

  it("still converts a document part of ordinary size", async () => {
    const prepared = await prepareOfficeSource(file("ok.docx", docxWithDocumentOf(2 * MiB)));
    expect(prepared.relationshipsRemoved).toBe(0);
  });
});

/** name -> each part's inflated bytes (base64), read independently of the preflight's rewrite. */
function partsOf(zip: Buffer): Record<string, string> {
  return Object.fromEntries(
    readZipEntries(zip).map((entry) => [
      entry.name,
      inflatePart(zip, entry, entry.uncompressedSize).toString("base64"),
    ])
  );
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** `emfBytes` with `record` spliced in right after the header (and the header's size fields left as they were). */
function injectAfterHeader(emfBytes: Buffer, record: Buffer): Buffer {
  return Buffer.concat([emfBytes.subarray(0, 108), record, emfBytes.subarray(108)]);
}

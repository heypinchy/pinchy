/**
 * Where the knowledge base's Office preflight must read a file the way the
 * reader behind it does: a false refusal of ordinary files, four ways past
 * the preflight, and two ways to make the web process inflate or grind for
 * minutes. Each test here was red before the change it pins, except those
 * showing that a real file Office or LibreOffice writes still passes.
 *
 *   1. `<asvg:svgBlip>` — what Office 365 and LibreOffice write for EVERY SVG
 *      picture — is not an `<svg` element; read as one, every such document
 *      would be refused outright.
 *   2. RTF `\binN` with N past 2^31: a sanitizer that skips N bytes reaches
 *      the end of the file, while LibreOffice overflows N to 0 and draws the
 *      hidden `\pict`.
 *   3. EMF/WMF pictures pass on their magic bytes, but an EMF+ image object
 *      (or an EMF inside a WMF) carries another picture LibreOffice detects by
 *      ITS bytes — an SVG that reads a local file into the PDF.
 *   4. A number format spelled `&#91;` decodes to `[` in exceljs's parser,
 *      past a check that counts literal brackets.
 *   5. One Office XML part, however large, would be inflated whole into the
 *      web heap; mammoth builds a DOM from it on top.
 *   6. A font relationship's target is drawn as a picture, by its bytes,
 *      when something names its id as one — and a version-0x0100 WMF or an
 *      EPS planted as a font passed a rule that only refused what looked like
 *      a document, an SVG or a 0x0300 WMF. A font is now kept only where
 *      fonts live, and only if it is one.
 *
 * Deterministic, no LibreOffice; the matching canaries are in
 * `office-convert.canary.libreoffice.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  zipOf,
} from "@/test-helpers/office-zip";
import {
  EMF_PLUS_DRAW_IMAGE,
  EMF_RECTANGLE,
  GDI_PUBLIC_ID,
  decoyedWmf,
  emf,
  emfComment,
  emfPlusBrushObject,
  emfPlusComment,
  emfPlusDualComment,
  emfPlusImageObject,
  emfPlusPenObject,
  emfPlusRecord,
  emfRecord,
  emfText,
  paddingComment,
  wmf,
  wmfEmbeddedEmf,
  wmfEscape,
  wmfText,
  WMF_RECTANGLE,
} from "@/test-helpers/metafile";

const MiB = 1024 * 1024;
const FIXTURES = join(__dirname, "../../fixtures/kb/office");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinchy-kb-reader-agreement-"));
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

describe("an SVG picture written by Office or LibreOffice is converted, not refused", () => {
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

describe("RTF `\\bin` that the sanitizer and LibreOffice could read differently is refused", () => {
  const svgHex = REACHING_SVG.toString("hex");
  const pict = `{\\pict\\pngblip\\picw400\\pich200 ${svgHex}}`;
  const rtf = (before: string) =>
    `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}}\\pard Body words\\par ${before}${pict}\\par After words\\par }`;

  it.each([
    // 2^31 is past what LibreOffice's 32-bit parameter
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

function imageCut(bytes: Buffer, target = "media/image1.emf"): number {
  const pkg = docxWith({
    documentRels: relationships(rel("rId5", REL_IMAGE, target)),
    parts: { [`word/${target}`]: bytes },
  });
  return sanitizeOoxmlPackage(pkg).removed;
}

/** The picture's bytes as the preflight hands them to LibreOffice — failing if it was cut. */
function keptPicture(bytes: Buffer, target = "media/image1.emf"): Buffer {
  const pkg = docxWith({
    documentRels: relationships(rel("rId5", REL_IMAGE, target)),
    parts: { [`word/${target}`]: bytes },
  });
  const { data, removed } = sanitizeOoxmlPackage(pkg);
  expect(removed, "the picture was cut").toBe(0);
  const entry = readZipEntries(data).find((e) => e.name === `word/${target}`)!;
  return inflatePart(data, entry, entry.uncompressedSize);
}

/** The metafile as kept: it was not cut, and none of `gone` is left in it. */
function keptWithout(bytes: Buffer, target: string, ...gone: Buffer[]): Buffer {
  const kept = keptPicture(bytes, target);
  for (const piece of gone)
    expect(kept.includes(piece), `${piece.toString("latin1")} left`).toBe(false);
  return kept;
}

const EMF_PLUS_MARK = Buffer.from("EMF+");
const WMFC_MARK = Buffer.from("WMFC");

describe("a metafile picture reaches LibreOffice as its own plain records, and nothing it embeds", () => {
  // An EMF+ image object whose compressed
  // bitmap is an SVG, behind 4 KiB of comment padding so the first kilobytes
  // look like a metafile and nothing else. LibreOffice draws the local file.
  const smuggled = emf(
    paddingComment(4400),
    emfPlusComment(emfPlusImageObject(REACHING_SVG), EMF_PLUS_DRAW_IMAGE),
    EMF_RECTANGLE
  );
  const svgMark = REACHING_SVG.subarray(0, 32);

  it("keeps an EMF whose EMF+ image object is an SVG behind 4 KiB of padding only without its EMF+ layer", () => {
    expect(smuggled.subarray(0, 4096).includes("<svg")).toBe(false);
    const kept = keptWithout(smuggled, "media/image1.emf", EMF_PLUS_MARK, svgMark);
    expect(kept.includes(EMF_RECTANGLE)).toBe(true);
  });

  // No EMF+ record is vouched for, by its kind or its brush: reading them the
  // way LibreOffice does is what a differential lives on. Every EMF+ comment
  // goes; the EMF records draw the picture.
  it.each([
    ["a PNG bitmap", emfPlusImageObject(PNG_1X1)],
    ["an embedded metafile", emfPlusImageObject(emf(EMF_RECTANGLE), "metafile")],
    ["a texture-brush", emfPlusBrushObject(2)],
    ["a pen filled by a texture brush", emfPlusPenObject(2)],
  ])("keeps an EMF whose EMF+ records carry %s only without them", (_, record) => {
    keptWithout(emf(emfPlusComment(record), EMF_RECTANGLE), "media/image1.emf", EMF_PLUS_MARK);
  });

  it.each([
    ["an object of a kind [MS-EMFPLUS] does not define", emfPlusRecord(0x4008, 0x0a00, u32(0))],
    ["a brush of a type [MS-EMFPLUS] does not define", emfPlusBrushObject(5)],
    ["a pen filled by a brush of such a type", emfPlusPenObject(5)],
  ])("keeps an EMF whose EMF+ records carry %s only without them", (_, record) => {
    keptWithout(emf(emfPlusComment(record), EMF_RECTANGLE), "media/image1.emf", EMF_PLUS_MARK);
  });

  it.each([
    ["a hatch", 1],
    ["a path gradient", 3],
    ["a linear gradient", 4],
  ])("keeps an EMF whose EMF+ brush is %s, without its EMF+ layer too", (_, brushType) => {
    const kept = keptWithout(
      emf(emfPlusComment(emfPlusBrushObject(brushType)), EMF_RECTANGLE),
      "media/image1.emf",
      EMF_PLUS_MARK
    );
    expect(kept.includes(EMF_RECTANGLE)).toBe(true);
  });

  it.each([
    ["an embedded EMF or EPS (multiformats)", 0x40000004],
    ["an embedded WMF", 0x80000001],
    ["an unknown public comment", 0x41414141],
  ])("keeps an EMF whose public comment carries %s only without the comment", (_, kind) => {
    const comment = emfComment(GDI_PUBLIC_ID, Buffer.concat([u32(kind), Buffer.alloc(64)]));
    keptWithout(emf(comment, EMF_RECTANGLE), "media/image1.emf", Buffer.from("GDIC"));
  });

  it("drops an EMF+ comment it could not even walk: no EMF+ record is read, so none is misread", () => {
    const unwalkable = emfComment(
      0x2b464d45,
      Buffer.from([0x08, 0x40, 0x00, 0x05, 0xff, 0, 0, 0, 0, 0, 0, 0])
    );
    keptWithout(emf(unwalkable, EMF_RECTANGLE), "media/image1.emf", EMF_PLUS_MARK);
  });

  /** An EMF whose fields are rewritten by `edit` after it is built. */
  const edited = (edit: (bytes: Buffer) => void, ...records: Buffer[]) => {
    const bytes = emf(...records);
    edit(bytes);
    return bytes;
  };

  // What is dropped is decided by where this walk says each record starts.
  // A reader that disagrees could find a record this walk never saw, so the
  // walk trusts no size it cannot check against another: the header's own
  // size against what a header holds, every record's against the file, and
  // the file's against the byte count its header states.
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
      "a header whose size swallows the EMF+ records after it",
      () => {
        const comment = Buffer.concat([
          paddingComment(4400),
          emfPlusComment(emfPlusImageObject(REACHING_SVG), EMF_PLUS_DRAW_IMAGE),
        ]);
        const bytes = injectAfterHeader(emf(EMF_RECTANGLE), comment);
        bytes.writeUInt32LE(108 + comment.length, 4);
        bytes.writeUInt32LE(bytes.length, 48);
        return bytes;
      },
    ],
    ["a header shorter than a header", () => edited((b) => b.writeUInt32LE(84, 4), EMF_RECTANGLE)],
    [
      "a description that lies outside the header",
      () =>
        edited((b) => {
          b.writeUInt32LE(4, 60);
          b.writeUInt32LE(108, 64);
        }, EMF_RECTANGLE),
    ],
    [
      "a byte count other than its length",
      () => edited((b) => b.writeUInt32LE(b.length + 4, 48), EMF_RECTANGLE),
    ],
    [
      "a record after its end-of-file record",
      () => {
        const bytes = Buffer.concat([emf(), EMF_RECTANGLE]);
        bytes.writeUInt32LE(bytes.length, 48);
        return bytes;
      },
    ],
  ])("cuts an EMF it cannot walk unambiguously: %s", (_, build) => {
    expect(imageCut(build())).toBe(1);
  });

  it("keeps an EMF whose header carries a description, as GDI writes one", () => {
    const description = Buffer.from("Pinchy\0Chart\0\0", "utf16le");
    const plain = emf(EMF_RECTANGLE);
    const bytes = Buffer.concat([plain.subarray(0, 108), description, plain.subarray(108)]);
    bytes.writeUInt32LE(108 + description.length, 4);
    bytes.writeUInt32LE(description.length / 2, 60);
    bytes.writeUInt32LE(108, 64);
    bytes.writeUInt32LE(bytes.length, 48);
    expect(keptPicture(bytes).equals(bytes)).toBe(true);
  });

  it("keeps a plain EMF as it is, and one whose EMF+ records only draw shapes without them", () => {
    const plain = emf(EMF_RECTANGLE);
    expect(keptPicture(plain).equals(plain)).toBe(true);
    keptWithout(
      emf(
        paddingComment(64),
        emfPlusComment(emfPlusBrushObject(0), emfPlusPenObject(0)),
        EMF_RECTANGLE
      ),
      "media/image1.emf",
      EMF_PLUS_MARK
    );
  });

  it("keeps a plain WMF as it is, and one carrying a plain EMF without it — as every WMF LibreOffice and Office write does", () => {
    const plain = wmf(WMF_RECTANGLE);
    expect(keptPicture(plain, "media/image1.wmf").equals(plain)).toBe(true);
    const kept = keptWithout(
      wmf(wmfEmbeddedEmf(emf(EMF_RECTANGLE)), WMF_RECTANGLE),
      "media/image1.wmf",
      WMFC_MARK
    );
    expect(kept.includes(WMF_RECTANGLE)).toBe(true);
  });

  // LibreOffice reassembles a WMF's embedded EMF only from "WMFC" records
  // whose CommentType is 1, Version 0x00010000 and CommentRecordCount not 0.
  // A walk that reassembled EVERY such record read decoys LibreOffice skips:
  // a decoy EMF header whose size swallowed the real chunk hid an EMF+ SVG
  // from the walk, the WMF was kept whole, and LibreOffice 26.2 and 7.4.7
  // drew the local files from the one chunk it did take. No chunk is matched
  // to LibreOffice's choice: every one goes.
  it.each([
    ["a Version other than 0x00010000", { version: 0x00020000 }],
    ["a CommentType other than 1", { commentType: 2 }],
    ["a CommentRecordCount of 0", { recordCount: 0 }],
  ])(
    "drops every embedded-EMF record, decoys with %s among them, and keeps the WMF's own drawing",
    (_, decoy) => {
      const kept = keptWithout(
        decoyedWmf(smuggled, decoy, WMF_RECTANGLE, wmfText("WMF words survive")),
        "media/image1.wmf",
        WMFC_MARK,
        EMF_PLUS_MARK,
        svgMark
      );
      expect(kept.includes(WMF_RECTANGLE)).toBe(true);
      expect(kept.includes(Buffer.from("WMF words survive", "latin1"))).toBe(true);
    }
  );

  /** A WMF whose records are rewritten by `edit` after it is built. */
  const editedWmf = (edit: (bytes: Buffer) => void, ...records: Buffer[]) => {
    const bytes = wmf(...records);
    edit(bytes);
    return bytes;
  };

  it.each([
    [
      "a size other than its length",
      () => editedWmf((b) => b.writeUInt32LE(b.readUInt32LE(28) + 1, 28), WMF_RECTANGLE),
    ],
    [
      "records after its end-of-file record",
      () => {
        const bytes = Buffer.concat([wmf(), WMF_RECTANGLE]);
        bytes.writeUInt32LE((bytes.length - 22) / 2, 28);
        return bytes;
      },
    ],
    ["no end-of-file record", () => wmf(WMF_RECTANGLE).subarray(0, -6)],
    [
      "a record running past the end",
      () => editedWmf((b) => b.writeUInt32LE(0x1000, 40), WMF_RECTANGLE),
    ],
  ])("cuts a WMF it cannot walk unambiguously: %s", (_, build) => {
    expect(imageCut(build(), "media/image1.wmf")).toBe(1);
  });

  // LibreOffice sniffs a picture's format from its first bytes; markup that
  // sat behind 4 KiB of comment padding moves into them once the padding goes.
  it("cuts a metafile whose own records, once what it embeds is gone, start like an SVG", () => {
    const markup = emfRecord(83, Buffer.concat([Buffer.alloc(76), REACHING_SVG]));
    const bytes = emf(paddingComment(4400), markup, EMF_RECTANGLE);
    expect(bytes.subarray(0, 4096).includes("<svg")).toBe(false);
    expect(imageCut(bytes)).toBe(1);
  });

  // LibreOffice takes a file for a WMF by its type (1 or 2) and header size
  // (9), whatever the version — 0x0100 (METAVERSION100) as well as 0x0300 —
  // and draws an EMF carried inside one. A version-0x0100 WMF that was not
  // recognised as a metafile was never walked, only cut or kept by a rule
  // for something else: as a font it was kept, and both LibreOffice 26.2 and
  // 7.4.7 drew the SVG in its embedded EMF.
  it("walks a WMF of version 0x0100 like any other: kept when plain, its embedded EMF dropped", () => {
    const plain = withWmfVersion(unplaceable(wmf(WMF_RECTANGLE)), 0x0100);
    expect(imageCut(plain, "media/image1.wmf")).toBe(0);

    const carrying = withWmfVersion(
      unplaceable(wmf(wmfEmbeddedEmf(smuggled), WMF_RECTANGLE)),
      0x0100
    );
    const kept = keptWithout(carrying, "media/image1.wmf", WMFC_MARK);
    expect(kept.includes(WMF_RECTANGLE)).toBe(true);
  });

  it("cuts an EPS picture, whatever WMF preview it carries: no EPS is walked", () => {
    expect(imageCut(epsWithPreview(unplaceable(wmf(WMF_RECTANGLE))), "media/image1.eps")).toBe(1);
  });

  it.each(["libreoffice-drawing.emf", "libreoffice-drawing.wmf"])(
    "keeps %s — a rectangle, an ellipse, text and a bitmap, as LibreOffice 26.2 writes them — words included, without what it embeds",
    (name) => {
      // LibreOffice writes the EMF "EMF+ Dual", and the WMF with the whole
      // drawing again as an EMF inside it. Both draw it once more in their
      // own records, which is what is kept.
      const bytes = readFileSync(join(FIXTURES, name));
      const isWmf = name.endsWith(".wmf");
      const kept = keptWithout(
        bytes,
        `media/image1.${isWmf ? "wmf" : "emf"}`,
        isWmf ? WMFC_MARK : EMF_PLUS_MARK
      );
      const words = Buffer.from("Chart label text", isWmf ? "latin1" : "utf16le");
      expect(kept.includes(words)).toBe(true);
    }
  );

  // Only the embedded EMF goes, not the whole picture: the WMF's own records
  // — its drawing, text included — stay, LibreOffice draws them instead, and
  // they are walked like any WMF's. What reached for a picture is gone.
  it("drops an embedded EMF that carries a picture, and keeps the WMF's own drawing: LibreOffice would draw that EMF instead", () => {
    const kept = keptWithout(
      wmf(wmfEmbeddedEmf(smuggled), WMF_RECTANGLE),
      "media/image1.wmf",
      WMFC_MARK,
      svgMark
    );
    expect(kept.includes(WMF_RECTANGLE)).toBe(true);
  });

  it("drops an embedded EMF that is not all there, and keeps the WMF's own drawing", () => {
    const record = wmfEmbeddedEmf(emf(EMF_RECTANGLE));
    record.writeUInt32LE(record.readUInt32LE(40) + 4, 40); // declares 4 bytes more than it carries
    const kept = keptWithout(wmf(record, WMF_RECTANGLE), "media/image1.wmf", WMFC_MARK);
    expect(kept.includes(WMF_RECTANGLE)).toBe(true);
  });

  it("drops a WMF's encapsulated PostScript, and keeps its drawing: no escape is kept", () => {
    const ps = Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n");
    const kept = keptWithout(wmf(wmfEscape(0x1014, ps), WMF_RECTANGLE), "media/image1.wmf", ps);
    expect(kept.includes(WMF_RECTANGLE)).toBe(true);
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

describe("a metafile keeps its words: what is dropped is what it embeds, never its own drawing", () => {
  // An EMF's words are GDI text records, and LibreOffice draws them into the
  // PDF's text layer — so cutting a metafile picture cut text from the index.
  // Office and LibreOffice write every EMF+ file as "EMF+ Dual": the EMF
  // records around the EMF+ layer draw the whole picture again. The EMF+
  // layer goes, always, and the rest stays.

  /** The SVG-carrying EMF+ file above: not dual, so its EMF records do not draw the picture. */
  const smuggled = emf(
    paddingComment(4400),
    emfPlusComment(emfPlusImageObject(REACHING_SVG), EMF_PLUS_DRAW_IMAGE),
    EMF_RECTANGLE
  );

  /** A dual EMF whose EMF+ layer smuggles an SVG, and whose GDI layer draws a shape and words. */
  const dualSmuggled = emf(
    paddingComment(4400),
    emfPlusDualComment(emfPlusImageObject(REACHING_SVG), EMF_PLUS_DRAW_IMAGE),
    EMF_RECTANGLE,
    emfText("Metafile words survive"),
    emfPlusDualComment()
  );

  it("keeps a dual EMF's GDI drawing, words included, without any of its EMF+ layer", () => {
    const kept = keptPicture(dualSmuggled);
    expect(kept.includes(Buffer.from("EMF+"))).toBe(false);
    expect(kept.includes(REACHING_SVG.subarray(0, 32))).toBe(false);
    expect(kept.includes(EMF_RECTANGLE)).toBe(true);
    expect(kept.includes(emfText("Metafile words survive"))).toBe(true);
  });

  it("rewrites the EMF header to the file it now is: its size, its record count", () => {
    const kept = keptPicture(dualSmuggled);
    expect(kept.readUInt32LE(48)).toBe(kept.length);
    let records = 0;
    for (let at = 0; at < kept.length; at += kept.readUInt32LE(at + 4)) records++;
    expect(kept.readUInt32LE(52)).toBe(records);
  });

  it("is stable: the rewritten picture passes a second preflight untouched", () => {
    const once = keptPicture(dualSmuggled);
    expect(keptPicture(once).equals(once)).toBe(true);
  });

  it("keeps LibreOffice's own dual EMF, with an SVG planted in its EMF+ layer, as its GDI drawing", () => {
    // The real thing: LibreOffice 26.2 writes "EMF+ Dual", and the fixture's
    // GDI layer carries the words "Chart label text". The padding keeps the
    // SVG out of the first 4 KiB, which would otherwise be judged as an SVG.
    const real = readFileSync(join(FIXTURES, "libreoffice-drawing.emf"));
    const planted = injectAfterHeader(
      real,
      Buffer.concat([
        paddingComment(4400),
        emfPlusDualComment(emfPlusImageObject(REACHING_SVG), EMF_PLUS_DRAW_IMAGE),
      ])
    );
    planted.writeUInt32LE(planted.length, 48);
    const kept = keptPicture(planted);
    expect(kept.includes(Buffer.from("Chart label text", "utf16le"))).toBe(true);
    expect(kept.includes(REACHING_SVG.subarray(0, 32))).toBe(false);
  });

  it("keeps an EMF+ file that is not dual as its EMF records alone: its EMF+ picture never reaches LibreOffice", () => {
    const kept = keptPicture(smuggled);
    expect(kept.includes(Buffer.from("EMF+"))).toBe(false);
    expect(kept.includes(REACHING_SVG.subarray(0, 32))).toBe(false);
    expect(kept.includes(EMF_RECTANGLE)).toBe(true);
  });

  it("drops a dual EMF's public comment along with its EMF+ layer: an embedded EMF, EPS or WMF in the GDI layer", () => {
    const comment = emfComment(GDI_PUBLIC_ID, Buffer.concat([u32(0x40000004), Buffer.alloc(64)]));
    const kept = keptPicture(
      emf(
        paddingComment(4400),
        emfPlusDualComment(emfPlusImageObject(REACHING_SVG)),
        comment,
        EMF_RECTANGLE
      )
    );
    expect(kept.includes(Buffer.from("GDIC"))).toBe(false);
    expect(kept.includes(Buffer.from("EMF+"))).toBe(false);
    expect(kept.includes(EMF_RECTANGLE)).toBe(true);
  });

  it("drops a WMF's PostScript and its embedded EMF alike", () => {
    const ps = wmfEscape(0x1014, Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n"));
    const kept = keptPicture(wmf(wmfEmbeddedEmf(smuggled), ps, WMF_RECTANGLE), "media/image1.wmf");
    expect(kept.includes(Buffer.from("WMFC"))).toBe(false);
    expect(kept.includes(Buffer.from("%!PS"))).toBe(false);
    expect(kept.includes(WMF_RECTANGLE)).toBe(true);
  });

  it("keeps a WMF's own words when its embedded EMF is dropped, and rewrites its header", () => {
    const kept = keptPicture(
      wmf(wmfEmbeddedEmf(smuggled), WMF_RECTANGLE, wmfText("Metafile words survive")),
      "media/image1.wmf"
    );
    expect(kept.includes(Buffer.from("Metafile words survive", "latin1"))).toBe(true);
    // Placeable header (22 bytes), then the WMF header: Size in 16-bit words.
    expect(kept.readUInt32LE(22 + 6) * 2).toBe(kept.length - 22);
  });
});

describe("a font is kept only where fonts live, and only if it is a font", () => {
  // A font relationship's target is drawn as a PICTURE when something names
  // its id as one, by whatever its bytes are — so a "font" that is a
  // version-0x0100 WMF or a DOS-binary EPS (both with an EMF inside whose
  // EMF+ image is an SVG reading a local file) passed a rule that only asked
  // whether the bytes looked like a document, an SVG or a 0x0300 WMF, and
  // LibreOffice 26.2 and 7.4.7 both drew the local file from the staged copy.
  // Fonts live in exactly two places: Word's font table and PowerPoint's
  // presentation part. Anywhere else the relationship is cut; there, the
  // bytes must BE a font in the format that writer uses.

  /**
   * The first 64 bytes of `word/fonts/font1.odttf` as LibreOffice 26.2 wrote
   * it into a .docx, and the `w:fontKey` its font table gave it: an sfnt
   * whose first 32 bytes are XORed with the key (ECMA-376 §17.8.1).
   */
  const LIBREOFFICE_ODTTF = Buffer.concat([
    Buffer.from(
      "01dfef9ad848ad12f04abc8a3e0c554c721f1b6ad85cad4af04ebcd63f0e444794cf8ee6000004f40000029447504f5333f19b620001810400009e8a47535542",
      "hex"
    ),
    Buffer.alloc(4096),
  ]);
  const LIBREOFFICE_FONT_KEY = "{01014A78-CABC-4EF0-12AC-5CD89AEFDE01}";

  /**
   * A `ppt/fonts/*.fntdata` as LibreOffice 26.2 wrote it into a .pptx: an
   * Embedded OpenType header — its first field the file's own length,
   * 680 508 bytes; `LP` at 34 — then the font, an sfnt, at 244. Only the
   * first 260 bytes are the real ones; the rest is the length it declares.
   */
  const LIBREOFFICE_EOT_HEAD = Buffer.from(
    "3c620a0048610a000200020000000000020b060603080402020400009001000000004c50ff6e00e7fffd00d22960240a0c200004ff0100600000ffdfbdb65e5b0000000000000000000000000000000000002c00440065006a006100560075002000530061006e007300200043006f006e00640065006e00730065006400000000000a0042006f006f006b00000000001a00560065007200730069006f006e00200032002e0033003700000000002c00440065006a006100560075002000530061006e007300200043006f006e00640065006e0073006500640000000000000042534750e40400000000000000000000000000000001000000140100000400404646544d",
    "hex"
  );
  const eot = (length = LIBREOFFICE_EOT_HEAD.readUInt32LE(0)) => {
    const out = Buffer.concat([
      LIBREOFFICE_EOT_HEAD,
      Buffer.alloc(length - LIBREOFFICE_EOT_HEAD.length),
    ]);
    const header = 244; // the real header's length: the font data follows it
    out.writeUInt32LE(length, 0);
    out.writeUInt32LE(length - header, 4);
    return out;
  };

  /** A real, un-obfuscated TrueType font: the one pdfjs ships. */
  const TRUETYPE = readFileSync(
    join(
      dirname(createRequire(__filename).resolve("pdfjs-dist/package.json")),
      "standard_fonts/LiberationSans-Regular.ttf"
    )
  );

  /** A version-0x0100 WMF whose embedded EMF carries an SVG that reads a local file. */
  const WMF_100 = withWmfVersion(
    unplaceable(
      wmf(
        wmfEmbeddedEmf(
          emf(
            paddingComment(4400),
            emfPlusComment(emfPlusImageObject(REACHING_SVG), EMF_PLUS_DRAW_IMAGE),
            EMF_RECTANGLE
          )
        ),
        WMF_RECTANGLE
      )
    ),
    0x0100
  );
  /** A DOS-binary EPS whose preview is that WMF, as version 0x0300 — what LibreOffice draws of an EPS. */
  const EPS = epsWithPreview(withWmfVersion(WMF_100, 0x0300));

  /** The 32 bytes ECMA-376 §17.8.1 XORs over a font's first 32: the GUID's 16 bytes, last first, twice. */
  const obfuscated = (font: Buffer, fontKey: string) => {
    const guid = Buffer.from(fontKey.replace(/[{}-]/g, ""), "hex").reverse();
    const out = Buffer.from(font);
    for (let i = 0; i < 32; i++) out[i] ^= guid[i % 16];
    return out;
  };

  const WML = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

  /** Relationships cut from a .docx whose font table embeds `font` — the place Word and LibreOffice put one. */
  function fontTableCut(font: Buffer, fontKey?: string): number {
    const embed = `<w:embedRegular r:id="rIdF"${fontKey ? ` w:fontKey="${fontKey}"` : ""}/>`;
    const pkg = docxWith({
      documentRels: relationships(rel("rId9", relType("fontTable"), "fontTable.xml")),
      parts: {
        "word/fontTable.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts ${WML}><w:font w:name="DejaVu Sans Condensed">${embed}</w:font></w:fonts>`,
        "word/_rels/fontTable.xml.rels": relationships(
          rel("rIdF", relType("font"), "fonts/font1.odttf")
        ),
        "word/fonts/font1.odttf": font,
      },
    });
    return sanitizeOoxmlPackage(pkg).removed;
  }

  /** Relationships cut from a .pptx whose `owner` part carries a font relationship to `font`. */
  function deckFontCut(font: Buffer, owner: "presentation" | "slide" = "presentation"): number {
    const PML = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    const fontRel = (target: string) => rel("rIdF", relType("font"), target);
    const pkg = zipOf({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      "_rels/.rels": relationships(rel("rId1", relType("officeDocument"), "ppt/presentation.xml")),
      "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${PML}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:embeddedFontLst><p:embeddedFont><p:font typeface="DejaVu Sans Condensed"/><p:regular r:id="rIdF"/></p:embeddedFont></p:embeddedFontLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": relationships(
        rel("rId2", relType("slide"), "slides/slide1.xml"),
        ...(owner === "presentation" ? [fontRel("fonts/font1.fntdata")] : [])
      ),
      "ppt/slides/slide1.xml": `<?xml version="1.0" encoding="UTF-8"?><p:sld ${PML}/>`,
      "ppt/slides/_rels/slide1.xml.rels": relationships(
        ...(owner === "slide" ? [fontRel("../fonts/font1.fntdata")] : [])
      ),
      "ppt/fonts/font1.fntdata": font,
    });
    return sanitizeOoxmlPackage(pkg).removed;
  }

  it("keeps the obfuscated font LibreOffice writes into a .docx's font table", () => {
    expect(fontTableCut(LIBREOFFICE_ODTTF, LIBREOFFICE_FONT_KEY)).toBe(0);
  });

  it("keeps a plain TrueType font in a font table", () => {
    expect(fontTableCut(TRUETYPE)).toBe(0);
  });

  it("keeps the Embedded OpenType font LibreOffice writes into a .pptx's presentation part", () => {
    // Its first field is its length, 0x000A623C: `<b` in its first two bytes.
    // A rule that read every font's first bytes as text took it for markup.
    expect(deckFontCut(eot())).toBe(0);
  });

  it.each([
    ["a version-0x0100 WMF carrying an EMF that reads a local file", WMF_100],
    ["a DOS-binary EPS whose WMF preview carries that EMF", EPS],
    ["bytes its key does not turn into a font", obfuscated(EPS, LIBREOFFICE_FONT_KEY)],
  ])("cuts a font-table font that is %s", (_, bytes) => {
    expect(fontTableCut(bytes, LIBREOFFICE_FONT_KEY)).toBe(1);
  });

  it("cuts a font-table font that its key turns into a font, but that is stored as a WMF header", () => {
    // The stored bytes are what a picture reference draws, and the key is the
    // planter's to choose: one that turns `00 01 00 00` into `01 00 09 00`
    // makes a font that LibreOffice's picture detection reads as a WMF.
    const wmfKey = "{00000000-0000-0000-0000-000000090101}";
    const font = obfuscated(TRUETYPE, wmfKey);
    expect(font.subarray(0, 4).toString("hex")).toBe("01000900");
    expect(fontTableCut(font, wmfKey)).toBe(1);
  });

  it.each([
    ["a version-0x0100 WMF", WMF_100],
    ["a DOS-binary EPS", EPS],
    ["a plain TrueType font: PowerPoint embeds Embedded OpenType, nothing else", TRUETYPE],
  ])("cuts a presentation font that is %s", (_, bytes) => {
    expect(deckFontCut(bytes)).toBe(1);
  });

  it("cuts an Embedded OpenType font whose length makes its first bytes a WMF header", () => {
    // An EOT starts with its own length, and 0x00090001 is `01 00 09 00`. A
    // bullet picture in presentation.xml (`a:buBlip`) draws a font
    // relationship's bytes — measured, 26.2 and 7.4.7 — so a font there is
    // also judged as the picture it would be.
    const polyglot = eot(0x00090001);
    expect(polyglot.subarray(0, 4).toString("hex")).toBe("01000900");
    expect(deckFontCut(polyglot)).toBe(1);
  });

  it.each([
    ["a document's own relationships", () => docxFontCut("document")],
    ["a header's relationships", () => docxFontCut("header")],
    ["a slide's relationships", () => deckFontCut(eot(), "slide")],
  ])(
    "cuts a font relationship in %s, even to a real font: no font is read from there",
    (_, cut) => {
      expect(cut()).toBe(1);
    }
  );

  /** A real TrueType font, related from the document part or a header part — places a picture can name it from. */
  function docxFontCut(owner: "document" | "header"): number {
    const fontRel = rel("rIdF", relType("font"), "fonts/font1.ttf");
    const pkg = docxWith({
      documentRels: relationships(
        rel("rId9", relType("header"), "header1.xml"),
        ...(owner === "document" ? [fontRel] : [])
      ),
      parts: {
        "word/header1.xml": `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${WML}/>`,
        "word/_rels/header1.xml.rels": relationships(...(owner === "header" ? [fontRel] : [])),
        "word/fonts/font1.ttf": TRUETYPE,
      },
    });
    return sanitizeOoxmlPackage(pkg).removed;
  }
});

describe("a number format is judged by what the XML parser makes of it", () => {
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
    // Measured: 200 000 styled cells with this format took
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

describe("no single Office XML part is inflated whole past a ceiling", () => {
  const DOC_HEAD = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>`;
  const DOC_TAIL = `</w:t></w:r></w:p></w:body></w:document>`;

  /**
   * A .docx whose document part is `xmlBytes` long and true about it, plus a
   * stored pad of random bytes so the archive stays under the ratio rule —
   * the shape that, at 400 MiB, ran the preflight to 1.3 GB RSS.
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

/** A placeable WMF without its 22-byte Aldus header: the plain WMF it wraps, as a program writes one in memory. */
function unplaceable(placeableWmf: Buffer): Buffer {
  return Buffer.from(placeableWmf.subarray(22));
}

/** A plain WMF with its header's version field set to `version` (0x0100 or 0x0300). */
function withWmfVersion(plainWmf: Buffer, version: number): Buffer {
  const out = Buffer.from(plainWmf);
  out.writeUInt16LE(version, 4);
  return out;
}

/**
 * A DOS-binary EPS: its 30-byte header (`C5 D0 D3 C6`), a scrap of
 * PostScript, and `preview` — the WMF a program shows instead of rendering
 * the PostScript, which is what LibreOffice draws.
 */
function epsWithPreview(preview: Buffer): Buffer {
  const ps = Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 400 200\nshowpage\n%%EOF\n");
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0xc6d3d0c5, 0);
  head.writeUInt32LE(30, 4);
  head.writeUInt32LE(ps.length, 8);
  head.writeUInt32LE(30 + ps.length, 12);
  head.writeUInt32LE(preview.length, 16);
  head.writeUInt16LE(0xffff, 28);
  return Buffer.concat([head, ps, preview]);
}

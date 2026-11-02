/**
 * CANARIES: an Office file on a mounted
 * share must not make the converter fetch from the network or embed a local
 * file. Anyone who can write to the share can plant one; the nightly reindex
 * converts it inside the web container, which has a network and can read the
 * OpenClaw workspaces.
 *
 * These drive the REAL LibreOffice against a REAL local HTTP listener with
 * crafted documents, because the only honest evidence that a setting stops a
 * fetch is a listener that heard nothing. Names are not evidence: of the
 * profile keys we tried, `Link = 2` ("never update links") by itself still
 * fetched, and a dead proxy by itself still embedded `file://` images.
 *
 * Three layers, each proven ALONE so one cannot silently carry the others:
 *   1. the full pipeline (preflight + locked profile),
 *   2. the locked profile alone (preflight bypassed — the layer that holds
 *      when the preflight has a gap),
 *   3. the preflight alone (a stock LibreOffice profile — the layer that holds
 *      when LibreOffice learns a new way to fetch),
 * plus a CONTROL: the same documents, stock profile, unsanitized, DO fetch or
 * read. A canary that cannot go red proves nothing.
 *
 * Not every vector has two layers, and each one says which it has. There is
 * a family the profile does NOT stop:
 * anything LibreOffice draws as an SVG reads `<image href="file:///…">` into
 * the PDF under the locked profile — an SVG picture, an altChunk importing
 * HTML, a font or an "Office part" whose bytes are SVG (LibreOffice resolves
 * `r:embed` by Id and detects the format from the bytes), a `data:` URL
 * claiming PNG, an RTF `\pict` (also one hidden behind a `\bin` the two
 * readers count differently), and an SVG carried INSIDE a metafile — an EMF+
 * image object, or an EMF inside a WMF — which is drawn as a raster, so the
 * local file's pixels reach the PDF rather than its text. For those the
 * preflight is the only layer (it cuts or refuses them), so they are absent
 * from layer 2 by design. A legacy OLE2 `.doc` with a linked picture has only
 * the profile: the preflight passes binary formats through untouched, so it
 * is absent from layer 3.
 *
 * And one vector has NO layer here: a legacy `.doc` whose embedded picture is
 * an SVG. The preflight cannot rewrite OLE2, and the profile does not stop
 * the SVG import. Its test below pins that it still leaks, so the gap is
 * written down where it can be seen and cannot quietly change; isolating the
 * converter itself (no network, no view of the workspaces) is being built on
 * branch feat/kb-office-convert-sidecar.
 *
 * Run it with `pnpm test:libreoffice` (vitest.libreoffice.config.ts: one file
 * at a time — two LibreOffice first starts in parallel workers raced on the
 * shared extension repository and one aborted, signal 6 in
 * `syncRepositories`, LibreOffice 7.4.7). It is excluded from `pnpm test`.
 * Gated on `soffice`: without it the suite skips, unless KB_REQUIRE_SOFFICE=1
 * says it must not. CI's `libreoffice` job runs it inside the Pinchy image
 * the pipeline built (the LibreOffice that ships), with no network at all —
 * the listener is on loopback. Locally, against an image that has vitest:
 *
 *   docker run --rm --network none --user root --entrypoint sh \
 *     --tmpfs /kb-small-volume:size=24m -e KB_SMALL_VOLUME=/kb-small-volume \
 *     -v "$PWD/packages/web/src:/app/packages/web/src:ro" \
 *     -v "$PWD/packages/web/vitest.libreoffice.config.ts:/app/packages/web/vitest.libreoffice.config.ts:ro" \
 *     -v "$PWD/packages/plugins/pinchy-files:/app/packages/plugins/pinchy-files:ro" \
 *     ghcr.io/heypinchy/pinchy:dev -c 'cd /app/packages/web && KB_REQUIRE_SOFFICE=1 \
 *       node_modules/.bin/vitest run --config vitest.libreoffice.config.ts'
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { constants as zlibConstants, deflateSync, gzipSync, inflateSync } from "node:zlib";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { convertOfficeFiles, type OfficeSource } from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";
import { prepareOfficeSource } from "@/lib/knowledge/office-preflight";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";
import {
  assembleZip,
  crc32,
  deflatedPart,
  inflatePart,
  rawPart,
  readZipEntries,
} from "@/lib/knowledge/office-zip";
import {
  documentXml,
  docxWith,
  REL_HYPERLINK,
  REL_IMAGE,
  relationships,
  relType,
} from "@/test-helpers/office-zip";
import {
  EMF_PLUS_DRAW_IMAGE,
  EMF_RECTANGLE,
  emf,
  emfPlusComment,
  emfPlusDualComment,
  emfPlusImageObject,
  emfText,
  paddingComment,
  wmf,
  wmfEmbeddedEmf,
  wmfText,
  WMF_RECTANGLE,
} from "@/test-helpers/metafile";

const execFileAsync = promisify(execFile);

const SOFFICE = process.env.KB_SOFFICE_BIN || "soffice";
const hasSoffice = spawnSync(SOFFICE, ["--version"], { stdio: "ignore" }).status === 0;
// CI runs this suite inside the image that ships LibreOffice, with
// KB_REQUIRE_SOFFICE=1: there a missing binary is a failure, never a skip.
if (!hasSoffice && process.env.KB_REQUIRE_SOFFICE === "1") {
  throw new Error(`KB_REQUIRE_SOFFICE=1, but "${SOFFICE} --version" did not run`);
}

// A 1x1 PNG. Any image will do: the question is whether it arrives in the PDF.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

describe.skipIf(!hasSoffice)("an Office file cannot make the converter fetch or embed", () => {
  let root: string;
  let corpus: string;
  let server: Server;
  let origin: string;
  const requests: string[] = [];

  /**
   * Which layers a vector is defended by on its own (see the header). A vector
   * missing from a layer is not a gap in the suite: it is a fact about that
   * layer, written down where the layer's test reads it.
   */
  interface Vector {
    path: string;
    /** Layer 2: the locked profile alone holds. */
    profile: boolean;
    /** Layer 3: the preflight alone holds — by refusing the file, or by cutting what it reaches for. */
    preflight: "refuses" | "sanitizes" | false;
  }

  /** Vector name -> planted file. Built once; every layer converts the same bytes. */
  const vectors = new Map<string, Vector>();

  /** Planted in every local-file vector; it must never reach a PDF's text. */
  const SECRET = "SVGSECRETMARKER";
  /** Words drawn by a metafile's own records: they must survive the preflight. */
  const EMF_WORDS = "EMFWORDSMARKER";
  const WMF_WORDS = "WMFWORDSMARKER";
  /** The altChunk's own text: present in a PDF only if this LibreOffice imported the chunk at all. */
  const ALT_CHUNK_BODY = "ALTCHUNKBODYMARKER";

  const drain = () => requests.splice(0, requests.length);

  function planted(
    name: string,
    body: string | Buffer,
    layers: Omit<Vector, "path"> = { profile: true, preflight: "sanitizes" }
  ): string {
    const path = join(corpus, name);
    writeFileSync(path, body);
    vectors.set(name, { path, ...layers });
    return path;
  }

  /** Text in a converted PDF, through the same pdfjs layer the indexer reads. */
  async function textOf(pdfPath: string): Promise<string> {
    return (await extractPdfPages(pdfPath)).map((page) => page.text).join(" ");
  }

  /**
   * Did a local file's PIXELS reach a picture in this PDF? The planted secret
   * SVG is a magenta band: a picture that holds exactly that colour was drawn
   * from it. For the vectors that draw it as a raster (a metafile's embedded
   * picture), its text never reaches the text layer, so this is the evidence.
   */
  function localPixelsIn(pdfPath: string): boolean {
    const pdf = readFileSync(pdfPath);
    const text = pdf.toString("latin1");
    const images = /\/Subtype\/Image[^>]*\/ColorSpace\/DeviceRGB[\s\S]*?>>\s*stream\r?\n/g;
    for (const match of text.matchAll(images)) {
      const start = match.index! + match[0].length;
      const end = text.indexOf("endstream", start);
      if (!match[0].includes("/FlateDecode") || end < 0) continue;
      const pixels = inflateSync(pdf.subarray(start, end), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      });
      for (let i = 0; i + 2 < pixels.length; i += 3) {
        if (pixels[i] === 0xff && pixels[i + 1] === 0x00 && pixels[i + 2] === 0xff) return true;
      }
    }
    return false;
  }

  /** Images LibreOffice drew into a PDF. A document with no picture has none. */
  function imagesIn(pdfPath: string): number {
    return (
      readFileSync(pdfPath)
        .toString("latin1")
        .match(/\/Subtype\s*\/Image\b/g) ?? []
    ).length;
  }

  /** A body paragraph drawing the picture behind relationship `relId` (`r:embed`). */
  const embeddedPicture = (relId: string) =>
    `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="3905000" cy="1905000"/><wp:docPr id="2" name="s"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="s"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3905000" cy="1905000"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

  /**
   * A 40x40 PNG of noise, stored (not compressed) so LibreOffice keeps its
   * bytes verbatim when it writes a legacy .doc — which lets the test find
   * them there and put an SVG in their place. Deterministic, so a run is
   * reproducible.
   */
  function noisePng(): Buffer {
    const chunk = (type: string, data: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body) >>> 0);
      return Buffer.concat([length, body, crc]);
    };
    const size = 40;
    const raw = Buffer.alloc((size * 3 + 1) * size);
    let seed = 0x2545f491;
    for (let i = 0; i < raw.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      raw[i] = i % (size * 3 + 1) === 0 ? 0 : seed >>> 24;
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw, { level: 0 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  const linkedPicture = (target: string, type = REL_IMAGE) =>
    docxWith({
      text: "Quarterly figures for Domzale",
      documentRels: relationships(
        `<Relationship Id="rId9" Type="${type}" Target="${target}" TargetMode="External"/>`
      ),
      pictureRelId: "rId9",
    });

  /** A real .pptx made by LibreOffice, then given an externally-linked picture. */
  function plantPptx(target: string): string {
    const fodp = join(root, "base.fodp");
    writeFileSync(
      fodp,
      `<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:body><office:presentation><draw:page draw:name="p1"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="3cm"><draw:text-box><text:p>Slide words for the canary deck</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document>`
    );
    const made = spawnSync(
      SOFFICE,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${join(root, "fixture-profile")}`,
        "--convert-to",
        "pptx",
        "--outdir",
        root,
        fodp,
      ],
      { encoding: "utf8" }
    );
    expect(made.status, made.stderr).toBe(0);

    const base = readFileSync(join(root, "base.pptx"));
    const entries = readZipEntries(base);
    const text = (name: string) =>
      inflatePart(
        base,
        entries.find((e) => e.name === name)!,
        8 * 1024 * 1024
      ).toString("utf8");

    let slide = text("ppt/slides/slide1.xml");
    let rels = text("ppt/slides/_rels/slide1.xml.rels");
    rels = rels.replace(
      "</Relationships>",
      `<Relationship Id="rIdX9" Type="${REL_IMAGE}" Target="${target}" TargetMode="External"/></Relationships>`
    );
    if (!slide.includes("xmlns:r=")) {
      slide = slide.replace(
        "<p:sld ",
        `<p:sld xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `
      );
    }
    slide = slide.replace(
      "</p:spTree>",
      `<p:pic><p:nvPicPr><p:cNvPr id="99" name="x"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="rIdX9"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1000000" y="3000000"/><a:ext cx="2000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree>`
    );
    const patched = assembleZip(
      entries.map((e) =>
        e.name === "ppt/slides/slide1.xml"
          ? deflatedPart(e.name, Buffer.from(slide))
          : e.name === "ppt/slides/_rels/slide1.xml.rels"
            ? deflatedPart(e.name, Buffer.from(rels))
            : rawPart(base, e)
      )
    );
    return planted("deck-linked-http.pptx", patched);
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pinchy-kb-canary-"));
    corpus = join(root, "data");
    mkdirSync(corpus, { recursive: true });

    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "image/png");
      res.end(PNG);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    origin = `http://127.0.0.1:${address.port}`;

    const localPng = join(root, "secret.png");
    writeFileSync(localPng, PNG);

    planted("linked-http.docx", linkedPicture(`${origin}/linked-http.png`));
    planted("linked-file.docx", linkedPicture(pathToFileURL(localPng).href));
    // A relationship LABELLED hyperlink, used as a picture link: LibreOffice
    // does not check the Type when it resolves an r:link id.
    planted(
      "mislabelled-hyperlink.docx",
      linkedPicture(`${origin}/mislabelled.png`, REL_HYPERLINK)
    );
    plantPptx(`${origin}/deck.png`);
    // The same HTML, named for three formats: LibreOffice sniffs content.
    const html = `<html><body><p>Hello html posing as an office file</p><img src="${origin}/html.png"></body></html>`;
    planted("posing.doc", html, { profile: true, preflight: "refuses" });
    planted("posing.docx", html, { profile: true, preflight: "refuses" });

    // --- What the locked profile does NOT stop ---
    const secretSvg = join(root, "secret.svg");
    writeFileSync(
      secretSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60"><rect width="400" height="60" fill="#ff00ff"/><text x="10" y="40" font-size="30">${SECRET}</text></svg>`
    );
    const svgUrl = pathToFileURL(secretSvg).href;
    const pngUrl = pathToFileURL(localPng).href;
    /** An SVG that draws the local secret SVG and PNG. */
    const reachingSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200"><image x="0" y="0" width="400" height="60" xlink:href="${svgUrl}"/><image x="0" y="80" width="40" height="40" xlink:href="${pngUrl}"/></svg>`;

    // An internal altChunk importing an embedded HTML part: LibreOffice's HTML
    // import draws <img src="file://…"> — a local PNG embedded, a local SVG's
    // text in the indexed text layer — whatever the profile says.
    planted(
      "altchunk-html.docx",
      docxWith({
        text: "Body words for the altChunk canary",
        documentRels: relationships(
          `<Relationship Id="rIdA" Type="${relType("aFChunk")}" Target="afchunk.htm"/>`
        ),
        body: `<w:altChunk r:id="rIdA"/>`,
        parts: {
          "word/afchunk.htm": `<html><body><p>${ALT_CHUNK_BODY}</p><img src="${pngUrl}"><img src="${svgUrl}" width="400" height="60"></body></html>`,
        },
      }),
      { profile: false, preflight: "sanitizes" }
    );
    // The same import, with nothing for the relationship allow-list to cut:
    // the altChunk's prefix is non-ASCII (an XML name, if not an ASCII one)
    // and its id is BORROWED from a font relationship — LibreOffice resolves
    // an altChunk's r:id without checking the Type — whose part is HTML
    // behind a UTF-16 byte-order mark. LibreOffice 26.2 read the local file
    // into the PDF from the staged copy, until the preflight read element
    // names the way a parser does and sniffed text past a byte-order mark.
    planted(
      "altchunk-borrowed-font.docx",
      docxWith({
        text: "Body words for the borrowed-font canary",
        documentRels: relationships(
          `<Relationship Id="rIdF" Type="${relType("font")}" Target="fonts/font1.odttf"/>`
        ),
        body: `<ä:altChunk xmlns:ä="http://schemas.openxmlformats.org/wordprocessingml/2006/main" r:id="rIdF"/>`,
        parts: {
          "word/fonts/font1.odttf": Buffer.from(
            `﻿<html><body><p>${ALT_CHUNK_BODY}</p><img src="${pngUrl}"><img src="${svgUrl}" width="400" height="60"></body></html>`,
            "utf16le"
          ),
        },
      }),
      { profile: false, preflight: "sanitizes" }
    );
    // The same import, with the altChunk itself out of sight: the document
    // part declares UTF-7, where `<` is `+ADw-`, so no scan reading its bytes
    // sees an element at all — LibreOffice decodes it as declared. Its id is
    // borrowed from a HEADER relationship (kept: a header is rendered from),
    // whose part is an Office header root wrapped round HTML. LibreOffice
    // 26.2 imported that header as HTML and read the local files into the
    // PDF from the staged copy, until the preflight refused a part it would
    // not read as UTF-8.
    const utf7 = (text: string) =>
      text.replace(/[<>"]/g, (c) => ({ "<": "+ADw-", ">": "+AD4-", '"': "+ACI-" })[c]!);
    planted(
      "altchunk-utf7-header.docx",
      docxWith({
        text: "Body words for the UTF-7 canary",
        documentRels: relationships(
          `<Relationship Id="rIdH" Type="${relType("header")}" Target="header1.xml"/>`
        ),
        parts: {
          "word/document.xml": documentXml(
            "Body words for the UTF-7 canary",
            undefined,
            utf7(`<w:altChunk r:id="rIdH"/>`)
          ).replace('encoding="UTF-8"', 'encoding="UTF-7"'),
          "word/header1.xml": `<!-- c --><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><html><body><p>${ALT_CHUNK_BODY}</p><img src="${pngUrl}"><img src="${svgUrl}" width="400" height="60"></body></html></w:hdr>`,
        },
      }),
      { profile: false, preflight: "refuses" }
    );
    // An altChunk importing a NESTED .docx — whose own relationships the
    // preflight never saw — with an externally linked picture.
    planted(
      "altchunk-nested.docx",
      docxWith({
        text: "Body words for the nested canary",
        documentRels: relationships(
          `<Relationship Id="rIdA" Type="${relType("aFChunk")}" Target="afchunk.docx"/>`
        ),
        body: `<w:altChunk r:id="rIdA"/>`,
        parts: { "word/afchunk.docx": linkedPicture(`${origin}/nested.png`) },
      }),
      { profile: true, preflight: "sanitizes" }
    );
    // An ordinary INTERNAL picture relationship to an SVG that reaches out.
    planted(
      "svg-picture.docx",
      docxWith({
        text: "Body words for the SVG canary",
        documentRels: relationships(
          `<Relationship Id="rId5" Type="${REL_IMAGE}" Target="media/image1.svg"/>`
        ),
        body: embeddedPicture("rId5"),
        parts: { "word/media/image1.svg": reachingSvg },
      }),
      { profile: false, preflight: "sanitizes" }
    );

    // --- SVG by its BYTES, whatever the Type ---
    // LibreOffice resolves r:embed by Id and never checks the Type, then
    // detects the picture's format from its content. Each of these drew a
    // local file into the PDF under the locked profile (26.2, measured).
    planted(
      "font-svgz.docx",
      docxWith({
        text: "Body words for the font canary",
        documentRels: relationships(
          `<Relationship Id="rIdF" Type="${relType("font")}" Target="fonts/font1.odttf"/>`
        ),
        body: embeddedPicture("rIdF"),
        parts: { "word/fonts/font1.odttf": gzipSync(Buffer.from(reachingSvg)) },
      }),
      { profile: false, preflight: "sanitizes" }
    );
    planted(
      "office-namespaced-svg.docx",
      docxWith({
        text: "Body words for the namespace canary",
        documentRels: relationships(
          `<Relationship Id="rIdX" Type="${relType("header")}" Target="media/x.xml"/>`
        ),
        body: embeddedPicture("rIdX"),
        parts: {
          "word/media/x.xml": reachingSvg.replace(
            'xmlns="http://www.w3.org/2000/svg"',
            'xmlns="http://schemas.microsoft.com/office/2006/x"'
          ),
        },
      }),
      { profile: false, preflight: "refuses" }
    );
    planted(
      "data-url-svg.docx",
      docxWith({
        text: "Body words for the data URL canary",
        documentRels: relationships(
          `<Relationship Id="rId5" Type="${REL_IMAGE}" Target="media/image1.svg"/>`
        ),
        body: embeddedPicture("rId5"),
        parts: {
          "word/media/image1.svg": `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200"><image x="0" y="0" width="400" height="200" xlink:href="data:image/png;base64,${Buffer.from(reachingSvg).toString("base64")}"/></svg>`,
        },
      }),
      { profile: false, preflight: "sanitizes" }
    );
    // An RTF file named .doc (Word writes these, so it is accepted) whose
    // `\pict` claims PNG and holds an SVG.
    planted(
      "rtf-picture.doc",
      `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}}\\pard Body words for the RTF canary\\par {\\pict\\pngblip\\picw400\\pich200\\picwgoal6000\\pichgoal3000 ${Buffer.from(reachingSvg).toString("hex")}}\\par }`,
      { profile: false, preflight: "sanitizes" }
    );

    // --- A picture INSIDE a metafile, and RTF \bin ---
    // An EMF passes the picture check on its magic bytes, but an EMF+ image
    // object carries another picture LibreOffice detects by ITS bytes. Behind
    // 4 KiB of comment padding the first bytes say nothing but "metafile";
    // LibreOffice drew the SVG — and the local file it reads — as a raster.
    const emfPlusSvg = emf(
      paddingComment(4400),
      emfPlusComment(emfPlusImageObject(Buffer.from(reachingSvg)), EMF_PLUS_DRAW_IMAGE),
      EMF_RECTANGLE
    );
    const metafilePicture = (target: string, bytes: Buffer) =>
      docxWith({
        text: "Body words for the metafile canary",
        documentRels: relationships(
          `<Relationship Id="rId5" Type="${REL_IMAGE}" Target="${target}"/>`
        ),
        body: embeddedPicture("rId5"),
        parts: { [`word/${target}`]: bytes },
      });
    planted("emfplus-svg.docx", metafilePicture("media/image1.emf", emfPlusSvg), {
      profile: false,
      preflight: "sanitizes",
    });
    // The same EMF carried whole inside a WMF (the "WMFC" comment Office uses).
    // The EMF is dropped and the WMF's own records — its words among them —
    // are drawn instead of the picture being cut.
    planted(
      "wmf-embedded-emf.docx",
      metafilePicture(
        "media/image1.wmf",
        wmf(wmfEmbeddedEmf(emfPlusSvg), WMF_RECTANGLE, wmfText(WMF_WORDS))
      ),
      { profile: false, preflight: "sanitizes" }
    );
    // An "EMF+ Dual" EMF — what Office and LibreOffice write —
    // draws everything twice. When only its EMF+ layer carries the picture,
    // that layer is dropped and the EMF records stay: the same drawing, its
    // words included, which a cut used to take out of the index.
    planted(
      "emfplus-dual-svg.docx",
      metafilePicture(
        "media/image1.emf",
        emf(
          paddingComment(4400),
          emfPlusDualComment(emfPlusImageObject(Buffer.from(reachingSvg)), EMF_PLUS_DRAW_IMAGE),
          EMF_RECTANGLE,
          emfText(EMF_WORDS),
          emfPlusDualComment()
        )
      ),
      { profile: false, preflight: "sanitizes" }
    );
    // `\bin` with 2^31: the sanitizer skipped to the end of the file, while
    // LibreOffice's 32-bit parameter overflowed to 0 and it drew the `\pict`.
    planted(
      "rtf-bin-overflow.doc",
      `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}}\\pard Body words for the RTF bin canary\\par {\\*\\pinchyx\\bin2147483648 X}{\\pict\\pngblip\\picw400\\pich200\\picwgoal6000\\pichgoal3000 ${Buffer.from(reachingSvg).toString("hex")}}\\par After words\\par }`,
      { profile: false, preflight: "refuses" }
    );

    // --- What ONLY the locked profile stops ---
    // A legacy binary .doc keeps a linked picture as a link. The preflight
    // passes OLE2 through untouched, so the profile is its one layer. Written
    // by LibreOffice itself from the linked .docx files above (a stock profile
    // fetches while it writes: those requests are drained below).
    const legacyDir = join(root, "legacy");
    mkdirSync(legacyDir, { recursive: true });
    // A picture LibreOffice will store verbatim in the .doc it writes, so its
    // bytes can be swapped for an SVG's afterwards (see the KNOWN GAP test).
    const noise = noisePng();
    const embeddedNoise = join(root, "embedded-noise.docx");
    writeFileSync(
      embeddedNoise,
      docxWith({
        text: "Body words for the legacy picture canary",
        documentRels: relationships(
          `<Relationship Id="rId5" Type="${REL_IMAGE}" Target="media/image1.png"/>`
        ),
        body: embeddedPicture("rId5"),
        parts: { "word/media/image1.png": noise },
      })
    );
    await execFileAsync(
      SOFFICE,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${join(root, "fixture-profile")}`,
        "--convert-to",
        "doc:MS Word 97",
        "--outdir",
        legacyDir,
        vectors.get("linked-http.docx")!.path,
        vectors.get("linked-file.docx")!.path,
        embeddedNoise,
      ],
      { timeout: 180_000 }
    );
    for (const name of ["linked-http", "linked-file"]) {
      const doc = join(corpus, `legacy-${name}.doc`);
      copyFileSync(join(legacyDir, `${name}.doc`), doc);
      expect(readFileSync(doc).subarray(0, 4).toString("hex")).toBe("d0cf11e0");
      vectors.set(`legacy-${name}.doc`, { path: doc, profile: true, preflight: false });
    }
    // The KNOWN GAP: the .doc's embedded picture, overwritten in place by an
    // SVG (space-padded to the PNG's length) that draws the local secret.
    const legacy = readFileSync(join(legacyDir, "embedded-noise.doc"));
    const at = legacy.indexOf(noise);
    expect(at, "LibreOffice stored the picture verbatim").toBeGreaterThan(0);
    const svgInPlace = Buffer.alloc(noise.length, 0x20);
    expect(Buffer.byteLength(reachingSvg)).toBeLessThan(noise.length);
    svgInPlace.write(reachingSvg, "latin1");
    const patched = Buffer.from(legacy);
    svgInPlace.copy(patched, at);
    planted("legacy-svg-picture.doc", patched, { profile: false, preflight: false });
    drain();
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  /** One stock-profile conversion to PDF. Async: see the CONTROL for why. */
  async function soffice(profile: string, outDir: string, inputs: string[]): Promise<void> {
    await execFileAsync(
      SOFFICE,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${profile}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        ...inputs,
      ],
      { timeout: 180_000 }
    );
  }

  /** Planted files (all, or those `pick` selects), as conversion sources, in a stable order. */
  const sources = (pick: (v: Vector) => boolean = () => true): OfficeSource[] =>
    [...vectors.values()].filter(pick).map((v) => ({ absPath: v.path }));

  const nameOf = (path: string) => path.split("/").pop()!;

  it("CONTROL: a stock profile converting the unsanitized files DOES fetch and embed — the canary can go red", async () => {
    const outDir = join(root, "control-out");
    mkdirSync(outDir, { recursive: true });
    // ASYNC on purpose: the listener lives in THIS process, and spawnSync
    // blocks the event loop that has to answer the fetch it is waiting for.
    await soffice(
      join(root, "control-profile"),
      outDir,
      sources().map((s) => s.absPath)
    );

    const fetched = drain();
    // The http image, the mislabelled hyperlink, the pptx, the two HTML files,
    // the nested package's own link and the legacy .doc's link all reached the
    // listener...
    for (const path of [
      "/linked-http.png",
      "/mislabelled.png",
      "/deck.png",
      "/html.png",
      "/nested.png",
    ]) {
      expect(
        fetched.some((r) => r.endsWith(` ${path}`)),
        `${path} in ${fetched.join(", ")}`
      ).toBe(true);
    }
    // ...the file:// pictures were drawn into their PDFs...
    for (const name of ["linked-file", "legacy-linked-file", "svg-picture"]) {
      expect(imagesIn(join(outDir, `${name}.pdf`)), name).toBeGreaterThan(0);
    }
    // ...and a local file's TEXT reached the text layer the index reads —
    // through every way of getting LibreOffice to draw an SVG.
    for (const name of [
      "svg-picture",
      "font-svgz",
      "office-namespaced-svg",
      "data-url-svg",
      "rtf-picture",
      "rtf-bin-overflow",
      "legacy-svg-picture",
    ]) {
      expect(await textOf(join(outDir, `${name}.pdf`)), name).toContain(SECRET);
    }
    // ...and through a metafile's own picture, the local file's PIXELS.
    for (const name of ["emfplus-svg", "wmf-embedded-emf", "emfplus-dual-svg"]) {
      expect(localPixelsIn(join(outDir, `${name}.pdf`)), name).toBe(true);
    }

    // Whether altChunk HTML is imported at all depends on the LibreOffice
    // version: 26.2 imports it and reads the local files (local PNG embedded,
    // local SVG's text indexed); 7.4.7 — the runtime image's — skips the chunk
    // entirely (measured). Where it is imported, it leaks; that is the claim.
    for (const name of ["altchunk-html", "altchunk-borrowed-font", "altchunk-utf7-header"]) {
      const altPdf = join(outDir, `${name}.pdf`);
      const altText = await textOf(altPdf);
      expect(
        !altText.includes(ALT_CHUNK_BODY) || (imagesIn(altPdf) > 0 && altText.includes(SECRET)),
        `${name}: an imported altChunk read the local files`
      ).toBe(true);
    }
  }, 240_000);

  it("1. full pipeline: nothing is fetched, no local file is embedded, the HTML posing as Word is refused", async () => {
    const store = new OfficeArtifactStore(join(root, "artifacts-full"));
    const outcomes = await convertOfficeFiles(sources(), { store });

    expect(drain()).toEqual([]);

    const byName = new Map(outcomes.map((o) => [nameOf(o.sourcePath), o]));
    for (const name of ["posing.doc", "posing.docx"]) {
      expect(byName.get(name)!.status, name).toBe("failed");
      expect(byName.get(name)!.reason).toMatch(/not a Word or PowerPoint document/);
    }
    // An "Office part" that is really an SVG is built to be imported: refused.
    expect(byName.get("office-namespaced-svg.docx")!.status).toBe("failed");
    expect(byName.get("office-namespaced-svg.docx")!.reason).toMatch(/should be Office XML/);
    // An Office part a parser would not read as UTF-8 — here UTF-7, hiding
    // an altChunk from every scan — is refused.
    expect(byName.get("altchunk-utf7-header.docx")!.status).toBe("failed");
    expect(byName.get("altchunk-utf7-header.docx")!.reason).toMatch(/UTF-8/);
    // A binary run two readers could disagree about: refused.
    expect(byName.get("rtf-bin-overflow.doc")!.status).toBe("failed");
    expect(byName.get("rtf-bin-overflow.doc")!.reason).toMatch(/binary run/);
    // The documents themselves still convert: a cut link costs a picture, not
    // the text — and no local file's text or picture reaches the PDF.
    // The two altChunk files are converted with the chunk cut, not refused
    // outright — so the rest of the document is searchable and the chunk's
    // own content is not.
    for (const name of [
      "linked-http.docx",
      "linked-file.docx",
      "mislabelled-hyperlink.docx",
      "deck-linked-http.pptx",
      "svg-picture.docx",
      "altchunk-html.docx",
      "altchunk-borrowed-font.docx",
      "altchunk-nested.docx",
      "font-svgz.docx",
      "data-url-svg.docx",
      "rtf-picture.doc",
      "emfplus-svg.docx",
      "wmf-embedded-emf.docx",
      "emfplus-dual-svg.docx",
      "legacy-linked-http.doc",
      "legacy-linked-file.doc",
    ]) {
      const outcome = byName.get(name)!;
      expect(outcome.status, `${name}: ${outcome.reason}`).toBe("converted");
      expect(imagesIn(outcome.artifactPath!), name).toBe(0);
      expect(localPixelsIn(outcome.artifactPath!), name).toBe(false);
      const text = await textOf(outcome.artifactPath!);
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain(ALT_CHUNK_BODY);
    }
    expect(await textOf(byName.get("altchunk-html.docx")!.artifactPath!)).toContain(
      "Body words for the altChunk canary"
    );
    expect(await textOf(byName.get("altchunk-borrowed-font.docx")!.artifactPath!)).toContain(
      "Body words for the borrowed-font canary"
    );
    expect(await textOf(byName.get("rtf-picture.doc")!.artifactPath!)).toContain(
      "Body words for the RTF canary"
    );
    // A metafile with a second drawing keeps it, words and all.
    // Glyph by glyph, as a metafile positions them, so pdfjs may split a word:
    // compared without whitespace.
    const glyphs = async (name: string) =>
      (await textOf(byName.get(name)!.artifactPath!)).replace(/\s+/g, "");
    expect(await glyphs("emfplus-dual-svg.docx")).toContain(EMF_WORDS);
    expect(await glyphs("wmf-embedded-emf.docx")).toContain(WMF_WORDS);
  }, 240_000);

  it("KNOWN GAP of the profile-only layer: a legacy .doc whose embedded picture is an SVG still draws a local file", async () => {
    // Today's TRUE behaviour, pinned on purpose rather than skipped. The
    // preflight cannot rewrite a binary .doc, and the locked profile does not
    // stop LibreOffice's SVG import from reading `<image href="file:///…">`.
    // The fix is not another check here but isolating the converter (no
    // network, no view of the workspaces): branch feat/kb-office-convert-sidecar.
    // When that lands this assertion goes red — flip it, and move the vector
    // into the full-pipeline test above.
    const store = new OfficeArtifactStore(join(root, "artifacts-known-gap"));
    const [outcome] = await convertOfficeFiles(
      [{ absPath: vectors.get("legacy-svg-picture.doc")!.path }],
      { store }
    );

    expect(drain()).toEqual([]);
    expect(outcome.status, outcome.reason).toBe("converted");
    const text = await textOf(outcome.artifactPath!);
    expect(text).toContain("Body words for the legacy picture canary");
    expect(text, "the local SVG's text reached the index").toContain(SECRET);
  }, 240_000);

  it("2. locked profile alone (preflight bypassed): nothing is fetched or embedded, whatever the file claims to be", async () => {
    const store = new OfficeArtifactStore(join(root, "artifacts-profile"));
    // Staged as links to the ORIGINAL planted bytes — HTML posing as Word and
    // all — exactly what the converter saw before any preflight existed. Only
    // the vectors this layer holds alone (see the header for the two it does not).
    const outcomes = await convertOfficeFiles(
      sources((v) => v.profile),
      { store, prepareSource: async () => null }
    );

    expect(drain()).toEqual([]);
    for (const outcome of outcomes) {
      if (outcome.status === "converted") {
        expect(imagesIn(outcome.artifactPath!), outcome.sourcePath).toBe(0);
        expect(await textOf(outcome.artifactPath!), outcome.sourcePath).not.toContain(SECRET);
      }
    }
    // Not vacuous: the files really were converted, not all rejected —
    // including the legacy .doc, whose only layer this is.
    const converted = outcomes
      .filter((o) => o.status === "converted")
      .map((o) => nameOf(o.sourcePath));
    expect(converted.length).toBeGreaterThanOrEqual(6);
    expect(converted).toEqual(
      expect.arrayContaining(["legacy-linked-http.doc", "legacy-linked-file.doc"])
    );
  }, 240_000);

  it("3. preflight alone (stock profile): the sanitized copies make no request and embed nothing", async () => {
    const stage = join(root, "sanitized");
    mkdirSync(stage, { recursive: true });
    const staged: string[] = [];
    // Not the legacy .doc: this layer passes binary formats through untouched.
    for (const [name, vector] of vectors) {
      if (!vector.preflight) continue;
      try {
        const prepared = await prepareOfficeSource(vector.path);
        const out = join(stage, name);
        writeFileSync(out, prepared.data);
        staged.push(out);
        expect(vector.preflight, name).toBe("sanitizes");
      } catch {
        // Refused (HTML posing as Word, an SVG posing as an Office part): never reaches a converter.
        expect(vector.preflight, name).toBe("refuses");
      }
    }
    expect(staged.map(nameOf).sort()).toEqual(
      [...vectors]
        .filter(([, v]) => v.preflight === "sanitizes")
        .map(([n]) => n)
        .sort()
    );

    const outDir = join(root, "sanitized-out");
    mkdirSync(outDir, { recursive: true });
    await soffice(join(root, "stock-profile"), outDir, staged);

    expect(drain()).toEqual([]);
    for (const path of staged) {
      const pdf = join(
        outDir,
        `${path
          .split("/")
          .pop()!
          .replace(/\.[^.]+$/, "")}.pdf`
      );
      expect(imagesIn(pdf), path).toBe(0);
      expect(await textOf(pdf), path).not.toContain(SECRET);
    }
  }, 240_000);

  it("converts a document with an SVG picture the way Office 365 and LibreOffice write it — not refused", async () => {
    // `<asvg:svgBlip>`, written next to every SVG picture and PowerPoint Icon,
    // must not be read as an `<svg` element and the whole document refused. Both files were written by LibreOffice 26.2.
    // (That the picture itself is KEPT is office-preflight.reader-agreement.test.ts's
    // claim: LibreOffice draws the icon as vectors, not as an image object.)
    const fixtures = join(__dirname, "../../fixtures/kb/office");
    const store = new OfficeArtifactStore(join(root, "artifacts-svg-icons"));
    const sourcesForIcons = ["svg-icon-letter.docx", "svg-icon-deck.pptx"].map((name) => {
      const path = join(corpus, name);
      copyFileSync(join(fixtures, name), path);
      return { absPath: path };
    });
    const outcomes = await convertOfficeFiles(sourcesForIcons, { store });

    expect(drain()).toEqual([]);
    const byName = new Map(outcomes.map((o) => [nameOf(o.sourcePath), o]));
    for (const [name, words] of [
      ["svg-icon-letter.docx", "Contract letter body text here"],
      ["svg-icon-deck.pptx", "Quarterly roadmap slide text"],
    ]) {
      const outcome = byName.get(name)!;
      expect(outcome.status, `${name}: ${outcome.reason}`).toBe("converted");
      expect(await textOf(outcome.artifactPath!), name).toContain(words);
    }
  }, 240_000);
});

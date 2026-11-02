/**
 * Builds crafted Office packages for tests: ordinary OOXML-shaped zips, and
 * the hostile variants the knowledge-base preflight exists for.
 *
 * Built with the production zip writer on purpose — and read back by
 * independent readers (mammoth/jszip, exceljs, LibreOffice) wherever a test
 * needs to prove the bytes are a real archive, so a writer bug cannot hide
 * behind a reader that shares it.
 */
import { constants as zlibConstants, deflateRawSync } from "node:zlib";

import {
  assembleZip,
  crc32,
  deflatedPart,
  rawPart,
  readZipEntries,
  type ZipPart,
} from "@/lib/knowledge/office-zip";

export const REL_IMAGE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
export const REL_HYPERLINK =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

export function relationships(...rels: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
}

/** A body paragraph, plus an optional picture whose bytes are fetched through relationship `linkId`, plus any extra body XML. */
export function documentXml(text: string, linkedPictureRelId?: string, extraBody = ""): string {
  const picture = linkedPictureRelId
    ? `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1905000" cy="1905000"/><wp:docPr id="1" name="x"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="${linkedPictureRelId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="1905000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p>${picture}${extraBody}</w:body></w:document>`;
}

/** A zip of `files` (name -> text/bytes). No Office semantics added: callers choose the parts. */
export function zipOf(files: Record<string, string | Buffer>): Buffer {
  return assembleZip(
    Object.entries(files).map(([name, content]) =>
      deflatedPart(name, typeof content === "string" ? Buffer.from(content) : content)
    )
  );
}

/**
 * A minimal .docx: content types, root rels, a document, and the document's
 * own relationships — plus any further `parts` (media, headers, the parts a
 * crafted relationship points at) and extra `body` XML.
 */
export function docxWith(opts: {
  text?: string;
  documentRels: string;
  pictureRelId?: string;
  body?: string;
  parts?: Record<string, string | Buffer>;
}) {
  return zipOf({
    "[Content_Types].xml": CONTENT_TYPES,
    "_rels/.rels": ROOT_RELS,
    "word/_rels/document.xml.rels": opts.documentRels,
    "word/document.xml": documentXml(
      opts.text ?? "Hello canary document",
      opts.pictureRelId,
      opts.body
    ),
    ...opts.parts,
  });
}

/** A 1x1 PNG: a real image for an image relationship to point at. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** The transitional relationship-type URI for `name` (`styles`, `aFChunk`, …). */
export const relType = (name: string) =>
  `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}`;

/** A one-element OOXML part in the WordprocessingML namespace, e.g. `ooxmlPart("w:styles")`. */
export const ooxmlPart = (qname: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${qname} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>`;

/**
 * An archive that DECLARES `declaredUncompressed` bytes for one entry while
 * carrying a few dozen real ones — what a decompression bomb looks like to
 * anything that reads only the central directory. Nothing in here inflates to
 * that size, so building (and rejecting) it costs nothing.
 */
export function declaredBomb(declaredUncompressed: number, entryName = "xl/worksheets/sheet1.xml") {
  const part: ZipPart = {
    ...deflatedPart(entryName, Buffer.alloc(64)),
    uncompressedSize: declaredUncompressed,
  };
  return assembleZip([deflatedPart("[Content_Types].xml", Buffer.from(CONTENT_TYPES)), part]);
}

const MiB = 1024 * 1024;

/**
 * One raw-deflate stream that inflates to `head`, then `spaceBytes` spaces,
 * then `tail` — built in about a megabyte of memory however large the inflated
 * size. Independent SYNC_FLUSH chunks concatenate into a single valid stream:
 * each ends on a byte boundary with a non-final block, and only the last block
 * is final.
 */
export function inflatesToSpaces(head: string, spaceBytes: number, tail: string): Buffer {
  const flush = { finishFlush: zlibConstants.Z_SYNC_FLUSH };
  const megabyte = deflateRawSync(Buffer.alloc(MiB, 0x20), flush);
  const pieces = [deflateRawSync(Buffer.from(head), flush)];
  for (let left = spaceBytes; left > 0; left -= MiB) {
    pieces.push(left >= MiB ? megabyte : deflateRawSync(Buffer.alloc(left, 0x20), flush));
  }
  pieces.push(deflateRawSync(Buffer.from(tail)));
  return Buffer.concat(pieces);
}

/** `archive` with entry `name` replaced by `part`; every other entry is copied exactly as stored. */
export function replaceEntry(archive: Buffer, name: string, part: ZipPart): Buffer {
  return assembleZip(
    readZipEntries(archive).map((entry) => (entry.name === name ? part : rawPart(archive, entry)))
  );
}

/**
 * A deflated entry for `name` whose stream holds `realBytes` of XML-ish
 * whitespace while the archive DECLARES `declaredBytes` — the lie that only
 * inflating can catch. The CRC is left at zero: nothing that trusts the
 * declared size ever gets far enough to compare it.
 */
export function lyingEntry(
  name: string,
  opts: { head: string; tail: string; realBytes: number; declaredBytes: number }
): ZipPart {
  return {
    name,
    method: 8,
    flags: 0,
    crc32: 0,
    uncompressedSize: opts.declaredBytes,
    data: inflatesToSpaces(opts.head, opts.realBytes, opts.tail),
  };
}

/** A truthful deflated entry of `head` + `spaceBytes` spaces + `tail`: declared size and CRC are real. */
export function truthfulSpacesEntry(
  name: string,
  opts: { head: string; tail: string; spaceBytes: number }
): ZipPart {
  const spaces = Buffer.alloc(MiB, 0x20);
  let crc = crc32(Buffer.from(opts.head));
  for (let left = opts.spaceBytes; left > 0; left -= MiB) {
    crc = crc32(left >= MiB ? spaces : spaces.subarray(0, left), crc);
  }
  crc = crc32(Buffer.from(opts.tail), crc);
  return {
    name,
    method: 8,
    flags: 0,
    crc32: crc,
    uncompressedSize: Buffer.byteLength(opts.head) + opts.spaceBytes + Buffer.byteLength(opts.tail),
    data: inflatesToSpaces(opts.head, opts.spaceBytes, opts.tail),
  };
}

/** Peak resident memory of this process so far, in bytes (`maxRSS` is reported in KiB). */
export function peakRss(): number {
  return process.resourceUsage().maxRSS * 1024;
}

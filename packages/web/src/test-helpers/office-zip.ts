/**
 * Builds crafted Office packages for tests: ordinary OOXML-shaped zips, and
 * the hostile variants the knowledge-base preflight exists for.
 *
 * Built with the production zip writer on purpose — and read back by
 * independent readers (mammoth/jszip, exceljs, LibreOffice) wherever a test
 * needs to prove the bytes are a real archive, so a writer bug cannot hide
 * behind a reader that shares it.
 */
import { assembleZip, deflatedPart, type ZipPart } from "@/lib/knowledge/office-zip";

export const REL_IMAGE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
export const REL_HYPERLINK =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

export function relationships(...rels: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
}

/** A body paragraph, plus an optional picture whose bytes are fetched through relationship `linkId`. */
export function documentXml(text: string, linkedPictureRelId?: string): string {
  const picture = linkedPictureRelId
    ? `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1905000" cy="1905000"/><wp:docPr id="1" name="x"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="${linkedPictureRelId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="1905000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p>${picture}</w:body></w:document>`;
}

/** A zip of `files` (name -> text/bytes). No Office semantics added: callers choose the parts. */
export function zipOf(files: Record<string, string | Buffer>): Buffer {
  return assembleZip(
    Object.entries(files).map(([name, content]) =>
      deflatedPart(name, typeof content === "string" ? Buffer.from(content) : content)
    )
  );
}

/** A minimal .docx: content types, root rels, a document, and the document's own relationships. */
export function docxWith(opts: { text?: string; documentRels: string; pictureRelId?: string }) {
  return zipOf({
    "[Content_Types].xml": CONTENT_TYPES,
    "_rels/.rels": ROOT_RELS,
    "word/_rels/document.xml.rels": opts.documentRels,
    "word/document.xml": documentXml(opts.text ?? "Hello canary document", opts.pictureRelId),
  });
}

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

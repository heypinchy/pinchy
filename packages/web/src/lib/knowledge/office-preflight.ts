/**
 * What the knowledge base checks about an Office file BEFORE a reader (exceljs,
 * mammoth, LibreOffice) touches it. Anyone who can write to a mounted share can
 * plant these files, and the reindex opens them inside the web container —
 * which has a network, and can read the OpenClaw workspaces. Three questions,
 * answered from the bytes alone (release review v0.10.0):
 *
 * ## 1. Is it the format its name says?
 *
 * LibreOffice picks its import filter from the CONTENT, not the extension. An
 * HTML file renamed `.doc` is imported by Writer/Web, and so is a flat-ODF
 * file: both fetch every `<img src>` they find. So the container is sniffed
 * from its magic bytes and anything other than the real thing is refused —
 * OLE2 (`.doc`/`.ppt`), a zip with an OOXML content-types part, or RTF where
 * Word writes it under a `.doc` name. Forcing `--infilter` instead would be
 * the textbook fix, but one filter cannot serve a mixed batch, and a hard
 * `.doc` filter would reject the OOXML-named-`.doc` and RTF-named-`.doc` files
 * real corpora are full of.
 *
 * ## 2. Will it explode?
 *
 * An OOXML file is a zip, and every reader inflates it whole. A few hundred
 * bytes can declare gigabytes — or declare a kilobyte and hold a gigabyte. The
 * guard `pinchy-files` already uses for `.docx` (#424) checks the declared
 * sizes (a ratio rule on top, a cap on the file itself), then inflates every
 * entry with its declared size as the ceiling, and builds a fresh archive from
 * the entries that held up. That copy is what every reader gets. Anything the
 * guard cannot parse is refused, never handed on.
 *
 * ## 3. Does it ask LibreOffice to read something it should not?
 *
 * An `a:blip r:link` points at a relationship, and a relationship marked
 * `TargetMode="External"` is a URL. LibreOffice fetches `http(s)://` ones
 * (an SSRF from inside the container) and EMBEDS `file://` ones into the PDF
 * (a local-file read, served to every reader of the knowledge base). That much
 * the locked profile (see `office-convert.ts`) stops. What it does NOT stop,
 * measured against LibreOffice 26.2: an INTERNAL `aFChunk` relationship to an
 * embedded HTML part, whose `<img src="file:///…">` lands in the PDF — a local
 * PNG embedded, a local PDF's or SVG's text in the indexed text layer — and an
 * internal SVG picture with `<image href="file:///…">`, which does the same.
 *
 * So the rule is not "internal is fine" but an ALLOW-LIST (`RENDERED_FROM`):
 * a relationship stays only if it is internal, of a type a page is rendered
 * from, and points at a part that is what that type promises. Everything else
 * is cut from a COPY of the package before conversion. The document text
 * survives; the linked picture, the template, the hyperlink's destination,
 * the embedded object's live data do not — none of which the PDF's text layer
 * carried. An altChunk is refused outright: cutting it would silently drop
 * text the author wrote.
 *
 * **Every** external relationship goes, hyperlinks included. A first version
 * spared `hyperlink` and was wrong: LibreOffice resolves an `r:link` id
 * WITHOUT checking the relationship's Type, so a hyperlink-labelled
 * relationship used as a picture link fetched exactly like an image one
 * (measured, 3 requests). The same fact is why a kept relationship's TARGET is
 * vetted, not just its type: an altChunk can borrow the id of an `image`.
 *
 * The legacy binary formats (`.doc`, `.ppt`) cannot be rewritten like this;
 * for them the locked profile is the only layer, and the canary
 * (`office-convert.canary.libreoffice.test.ts`) says so per vector.
 */
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";

import {
  verifiedZipCopy,
  ZipLimitError,
  type ZipLimits,
} from "../../../../plugins/pinchy-files/docx-zip-guard";

import { OfficeFileRejectedError, isPresentationFile } from "./office-formats";
import {
  assembleZip,
  deflatedPart,
  inflatePart,
  rawPart,
  readZipEntries,
  type ZipEntryInfo,
} from "./office-zip";

const MiB = 1024 * 1024;

/**
 * The largest Office file we will load to convert. Past it the file is listed
 * as unsearchable instead. 200 MiB is well beyond any document a person writes
 * (a deck full of photographs is the realistic extreme) and small enough that
 * the copy we stage cannot threaten the heap.
 */
export const OFFICE_MAX_FILE_BYTES = 200 * MiB;

/**
 * The largest workbook we will read. exceljs builds the full cell model, which
 * costs many times the sheet XML it came from, so this is deliberately tighter
 * than the conversion cap.
 */
export const XLSX_MAX_FILE_BYTES = 100 * MiB;

const RATIO_RULE = { maxCompressionRatio: 200, ratioFloorBytes: 16 * MiB } as const;

/** Word and PowerPoint packages: media is stored near ratio 1, so the ceiling is generous. */
const OOXML_LIMITS: ZipLimits = { maxDecompressedBytes: 500 * MiB, ...RATIO_RULE };

/** Workbooks: tighter, because the model exceljs builds is heavier than the XML it reads. */
const XLSX_LIMITS: ZipLimits = { maxDecompressedBytes: 256 * MiB, ...RATIO_RULE };

/** No real relationship part is anywhere near this; a bigger one is not one. */
const MAX_RELS_BYTES = 4 * MiB;

export interface PreparedSource {
  /** The bytes to convert. A snapshot: what was checked is what is converted. */
  data: Buffer;
  /**
   * sha256 of the file's bytes AS THIS READ SAW THEM — the bytes that were
   * checked, and from which `data` was made. The converter keys its artifact
   * on this, not on any earlier read: the file sits on a share its planter can
   * still write to, and a hash from a different read can name different bytes.
   */
  contentHash: string;
  /** Relationships cut from the package; 0 when it was handed through as it was. */
  relationshipsRemoved: number;
}

export interface PreflightOptions {
  /** Test seam; production uses the module's cap. */
  maxBytes?: number;
}

/**
 * Reads at most `maxBytes` of `absPath`, from ONE open handle: the size that is
 * checked is the size of the bytes that are read.
 */
async function readCapped(absPath: string, maxBytes: number): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(absPath, "r");
    const { size } = await handle.stat();
    if (size > maxBytes) {
      throw new OfficeFileRejectedError(
        "too_large",
        `the file is ${size} bytes, past the ${maxBytes}-byte limit`
      );
    }
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return read === size ? buffer : buffer.subarray(0, read);
  } finally {
    await handle?.close();
  }
}

/**
 * The archive, verified by its REAL contents, as a fresh copy for the reader
 * (see `verifiedZipCopy`): declared sizes within `limits`, every entry
 * inflated once with its declared size as the ceiling, and nothing carried
 * over that the check did not see.
 *
 * FAIL CLOSED. A limit violation, a lie about a size, and a central directory
 * this cannot parse are all refusals; none of them is ever handed on to a
 * reader to "diagnose". The earlier version handed parse failures on, and a
 * bomb behind 64 junk bytes is a parse failure here while JSZip opens it
 * without complaint (release review v0.10.0: 989 MB RSS from a 465 KB file).
 */
async function verifiedCopy(buffer: Buffer, limits: ZipLimits, what: string): Promise<Buffer> {
  try {
    return await verifiedZipCopy(buffer, limits);
  } catch (err) {
    if (err instanceof ZipLimitError) throw new OfficeFileRejectedError("too_large", err.message);
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `this file is not a valid ${what}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * The workbook's bytes, read once and verified — and the VERIFIED COPY is
 * what exceljs is given, so the file it parses is the file that was checked.
 *
 * Refuses anything the guard refuses, including a file that is not a zip at
 * all. `extractXlsx` reports that case as the unreadable workbook it is.
 */
export async function readWorkbookBuffer(
  absPath: string,
  opts: PreflightOptions = {}
): Promise<Buffer> {
  const buffer = await readCapped(absPath, opts.maxBytes ?? XLSX_MAX_FILE_BYTES);
  return verifiedCopy(buffer, XLSX_LIMITS, "workbook archive");
}

/** The `.docx` bytes for the word-count oracle, verified the same way as the conversion input. */
export async function readGuardedDocx(absPath: string): Promise<Buffer> {
  const buffer = await readCapped(absPath, OFFICE_MAX_FILE_BYTES);
  return verifiedCopy(buffer, OOXML_LIMITS, "Office Open XML package");
}

// ---------------------------------------------------------------------------
// 1. Is it the format its name says?
// ---------------------------------------------------------------------------

type Container = "ole2" | "zip" | "rtf";

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function sniffContainer(head: Buffer): Container | null {
  if (head.subarray(0, 8).equals(OLE2_MAGIC)) return "ole2";
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return "zip";
  if (head.subarray(0, 5).toString("latin1") === "{\\rtf") return "rtf";
  return null;
}

/** What each extension may actually contain. A deck is never RTF. */
function allowedContainers(path: string): readonly Container[] {
  return isPresentationFile(path) ? ["ole2", "zip"] : ["ole2", "zip", "rtf"];
}

// ---------------------------------------------------------------------------
// 3. Does it ask LibreOffice to read something it should not?
// ---------------------------------------------------------------------------

/**
 * The start of a `<Relationship` element, with any namespace prefix. Sticky, so
 * it is only ever tried AT a position the scanner chose: a global regex that
 * also consumed the whole tag would rescan to the end of the part from every
 * unterminated `<Relationship ` — quadratic on a hostile 4 MiB part.
 */
const RELATIONSHIP_START = /<(?:[A-Za-z_][\w.-]*:)?Relationship(?=[\s/>])/y;
const CLOSING_TAG = /\s*<\/(?:[A-Za-z_][\w.-]*:)?Relationship\s*>/y;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Starts with a URI scheme, or is a UNC / protocol-relative path. */
const SCHEME_OR_NETWORK_PATH = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\\\\|\/\/)/;
/** A DTD can define entities, and an entity can spell markup no text match sees. No Office writer emits one. */
const DTD = /<!(?:DOCTYPE|ENTITY)/i;

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    if (!attributes.has(match[1])) attributes.set(match[1], match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/**
 * Is this relationship plainly internal? A target mode that is absent or
 * exactly `Internal`, and a target that is a relative part path. Everything
 * else — External, an unfamiliar mode, an entity (`&`) that an XML parser
 * would decode into something else, a target carrying a scheme — is not.
 */
function isInternal(attributes: Map<string, string>): boolean {
  const mode = attributes.get("TargetMode");
  if (mode !== undefined && mode !== "Internal") return false;
  const target = attributes.get("Target");
  if (target === undefined) return false;
  if (target.includes("&")) return false;
  // WHATWG URL parsing ignores tabs and newlines inside a scheme.
  return !SCHEME_OR_NETWORK_PATH.test(target.replace(/[\t\n\r ]/g, ""));
}

const unexpected = (detail: string) => new OfficeFileRejectedError("unexpected_content", detail);

/**
 * Removes every relationship `keep` says no to from the text of a `.rels`
 * part (decoded as latin1, so the round trip is byte-exact for whatever
 * encoding it declared). `keep` may also throw, to refuse the package.
 */
function filterRelationships(
  xml: string,
  keep: (attributes: Map<string, string>) => boolean
): { xml: string; removed: number } {
  if (DTD.test(xml)) throw unexpected("a relationship part declares a DOCTYPE");

  let out = "";
  let cursor = 0;
  let removed = 0;

  const malformed = () => unexpected("a relationship part is not well-formed");

  let at = 0;
  // One forward pass: every position is looked at once, whatever the part holds.
  while ((at = xml.indexOf("<", at)) !== -1) {
    RELATIONSHIP_START.lastIndex = at;
    const start = RELATIONSHIP_START.exec(xml);
    if (!start) {
      at++;
      continue;
    }

    // Find the tag's end honouring quotes, so a `>` inside an attribute value
    // cannot end it early. No end at all means the part is not well-formed XML
    // — refused outright, which is also what keeps this pass linear.
    let quote = "";
    let close = at + start[0].length;
    for (; close < xml.length; close++) {
      const c = xml[close];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (close >= xml.length) throw malformed();

    const tag = xml.slice(at, close + 1);
    let end = close + 1;
    if (keep(attributesOf(tag))) {
      at = end;
      continue;
    }

    if (!tag.endsWith("/>")) {
      // `<Relationship …></Relationship>`: take the closing tag with it, or
      // the part would no longer be well-formed.
      CLOSING_TAG.lastIndex = end;
      const closing = CLOSING_TAG.exec(xml);
      if (!closing) throw malformed();
      end += closing[0].length;
    }
    out += xml.slice(cursor, at);
    cursor = end;
    removed++;
    at = end;
  }

  return removed === 0 ? { xml, removed: 0 } : { xml: out + xml.slice(cursor), removed };
}

/**
 * Removes every relationship that is not plainly internal from a `.rels` part.
 *
 * **Every** external relationship goes, hyperlinks included. A first version
 * spared `hyperlink` and was wrong: LibreOffice resolves an `r:link` id
 * WITHOUT checking the relationship's Type, so a hyperlink-labelled
 * relationship used as a picture link fetched exactly like an image one
 * (measured, 3 requests). The package sanitizer below goes further still.
 */
export function stripExternalRelationships(xml: string): { xml: string; removed: number } {
  return filterRelationships(xml, isInternal);
}

// --- The allow-list --------------------------------------------------------

/**
 * What a kept relationship's target must turn out to be.
 *
 * - `xml`   — an Office Open XML part: XML whose root element is in an OOXML
 *             (or Microsoft Office extension) namespace, with no DTD.
 * - `image` — a picture: a raster or metafile format by its magic bytes, or an
 *             SVG that references nothing outside itself.
 * - `font`  — an embedded (usually obfuscated) font: opaque bytes, as long as
 *             they are not a document format some import filter would take.
 */
type TargetClass = "xml" | "image" | "font";

const TRANSITIONAL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships/";
const MS_OFFICE = "http://schemas.microsoft.com/office/";

/**
 * The relationship types a converted page is RENDERED from, by the URI
 * ECMA-376 (transitional and strict) and Microsoft's extensions give them —
 * and nothing else. Release review v0.10.0 showed that "internal is fine" was
 * the wrong rule: an internal `aFChunk` imports an embedded HTML part, and
 * that importer resolves `<img src="file:///…">` past the locked profile.
 *
 * Deliberately NOT here, so cut (the document's text survives without them):
 * `oleObject`, `package` (a chart's embedded workbook, an embedded document:
 * LibreOffice draws charts from the chart part's cached values and objects
 * from their preview picture), `subDocument`, `attachedTemplate`, `frame`,
 * `hyperlink` (always external in a real file), `customXml`/`customXmlProps`,
 * `vbaProject`, `control`/ActiveX, `vmlDrawing`, `printerSettings`,
 * `audio`/`video`/`media`, mail-merge sources, web extensions, signatures.
 * `aFChunk` is not cut but REFUSED (see `assertNoAltChunk`).
 *
 * Checked against real Word and PowerPoint files (comments, footnotes,
 * headers, people, custom properties, notes, handout masters) and against
 * LibreOffice-written charts and SmartArt: converting the sanitized copy
 * produced the same text as the original.
 */
const RENDERED_FROM: ReadonlyMap<string, TargetClass> = new Map([
  ...[
    ["officeDocument", "xml"],
    ["styles", "xml"],
    ["numbering", "xml"],
    ["fontTable", "xml"],
    ["font", "font"],
    ["theme", "xml"],
    ["themeOverride", "xml"],
    ["settings", "xml"],
    ["webSettings", "xml"],
    ["header", "xml"],
    ["footer", "xml"],
    ["footnotes", "xml"],
    ["endnotes", "xml"],
    ["comments", "xml"],
    ["glossaryDocument", "xml"],
    ["image", "image"],
    ["chart", "xml"],
    ["chartUserShapes", "xml"],
    ["diagramData", "xml"],
    ["diagramLayout", "xml"],
    ["diagramQuickStyle", "xml"],
    ["diagramColors", "xml"],
    ["slide", "xml"],
    ["slideLayout", "xml"],
    ["slideMaster", "xml"],
    ["notesSlide", "xml"],
    ["notesMaster", "xml"],
    ["handoutMaster", "xml"],
    ["presProps", "xml"],
    ["viewProps", "xml"],
    ["tableStyles", "xml"],
    ["commentAuthors", "xml"],
    ["extended-properties", "xml"],
    ["custom-properties", "xml"],
    // Strict OOXML's spelling of the two above.
    ["extendedProperties", "xml"],
    ["customProperties", "xml"],
  ].flatMap(([name, kind]) => [
    [TRANSITIONAL + name, kind as TargetClass] as const,
    [STRICT + name, kind as TargetClass] as const,
  ]),
  ["http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "xml"],
  // An older spelling some writers still emit.
  [
    "http://schemas.openxmlformats.org/officedocument/2006/relationships/metadata/core-properties",
    "xml",
  ],
  ["http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail", "image"],
  [`${MS_OFFICE}2007/relationships/stylesWithEffects`, "xml"],
  [`${MS_OFFICE}2007/relationships/diagramDrawing`, "xml"],
  [`${MS_OFFICE}2007/relationships/hdphoto`, "image"],
  [`${MS_OFFICE}2011/relationships/people`, "xml"],
  [`${MS_OFFICE}2011/relationships/commentsExtended`, "xml"],
  [`${MS_OFFICE}2016/09/relationships/commentsIds`, "xml"],
  [`${MS_OFFICE}2018/08/relationships/commentsExtensible`, "xml"],
  [`${MS_OFFICE}2011/relationships/chartStyle`, "xml"],
  [`${MS_OFFICE}2011/relationships/chartColorStyle`, "xml"],
  [`${MS_OFFICE}2018/10/relationships/comments`, "xml"],
  [`${MS_OFFICE}2018/10/relationships/authors`, "xml"],
]);

const AFCHUNK = new Set([TRANSITIONAL + "aFChunk", STRICT + "aFChunk"]);

/** The namespaces an OOXML part's root element may live in. */
const OOXML_NAMESPACE =
  /^(?:http:\/\/schemas\.openxmlformats\.org\/|http:\/\/purl\.oclc\.org\/ooxml\/|http:\/\/schemas\.microsoft\.com\/office\/)/;

/** `<w:altChunk …>`, any prefix: content imported through a second filter. */
const ALT_CHUNK = /<(?:[A-Za-z_][\w.-]*:)?altChunk[\s/>]/;

/** No SVG picture we keep is anywhere near this; a bigger one is not drawn. */
const MAX_SVG_BYTES = 16 * MiB;

function refuseAltChunk(): never {
  throw unexpected(
    "the document embeds content in another format (altChunk), which LibreOffice would import through a second, unchecked filter"
  );
}

/** The local name and namespace of an XML document's root element, or null if it has none we can read. */
function rootElement(xml: string): { name: string; namespace: string | undefined } | null {
  // A UTF-8 byte-order mark, as the latin1 decoding here spells it. Real Word
  // files carry one (two contracts' settings.xml in the corpus check did).
  let at = xml.startsWith("\u00EF\u00BB\u00BF") ? 3 : 0;
  for (;;) {
    while (at < xml.length && /[\s﻿]/.test(xml[at])) at++;
    if (xml.startsWith("<?", at)) {
      const end = xml.indexOf("?>", at);
      if (end < 0) return null;
      at = end + 2;
    } else if (xml.startsWith("<!--", at)) {
      const end = xml.indexOf("-->", at);
      if (end < 0) return null;
      at = end + 3;
    } else break;
  }
  const open = /^<([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?(?=[\s/>])/.exec(
    xml.slice(at, at + 512)
  );
  if (!open) return null;
  const [prefix, local] = open[2] === undefined ? [undefined, open[1]] : [open[1], open[2]];
  const tagEnd = xml.indexOf(">", at);
  if (tagEnd < 0) return null;
  const attributes = attributesOf(xml.slice(at, tagEnd + 1));
  return { name: local, namespace: attributes.get(prefix ? `xmlns:${prefix}` : "xmlns") };
}

/**
 * Is `bytes` a picture by its magic number? PNG, JPEG, GIF, BMP, TIFF, EMF,
 * WMF (placeable and plain), JPEG XR (`hdphoto`), WebP, ICO.
 */
function isRasterOrMetafile(bytes: Buffer): boolean {
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  return (
    starts("89504e470d0a1a0a") ||
    starts("ffd8ff") ||
    starts("474946383761") ||
    starts("474946383961") ||
    starts("424d") ||
    starts("49492a00") ||
    starts("4d4d002a") ||
    starts("49492b00") ||
    starts("4d4d002b") ||
    starts("d7cdc69a") ||
    starts("010009000003") ||
    starts("020009000003") ||
    starts("4949bc") ||
    starts("00000100") ||
    (starts("52494646") && bytes.subarray(8, 12).toString("latin1") === "WEBP") ||
    (starts("01000000") && bytes.subarray(40, 44).toString("latin1") === " EMF")
  );
}

const SVG_HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)/gi;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|bmp|webp);base64,[A-Za-z0-9+/=\s]*$/;

/**
 * Does this SVG reference nothing outside itself? Every `href` must be a
 * fragment of this same file or an embedded raster, every CSS `url()` a
 * fragment; no stylesheet imports, no DTD, no entities hiding a reference.
 *
 * Measured against LibreOffice 26.2 under the locked profile: an internal SVG
 * picture with `<image href="file:///…">` drew the local file into the PDF —
 * a local PNG embedded, a local SVG's text in the indexed text layer.
 */
function isSelfContainedSvg(text: string): boolean {
  if (DTD.test(text) || /@import/i.test(text)) return false;
  for (const match of text.matchAll(SVG_HREF)) {
    const value = (match[1] ?? match[2]).trim();
    if (value.includes("&")) return false;
    if (!value.startsWith("#") && !DATA_IMAGE.test(value)) return false;
  }
  for (const match of text.matchAll(CSS_URL)) {
    if (!match[2].trim().startsWith("#")) return false;
  }
  return true;
}

/** A document format some import filter would take, by its first bytes. */
function looksLikeDocument(head: Buffer): boolean {
  const text = head.toString("latin1").replace(/^[\s﻿ï»¿]+/, "");
  return (
    head.subarray(0, 8).equals(OLE2_MAGIC) ||
    (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) ||
    text.startsWith("{\\rtf") ||
    text.startsWith("%PDF") ||
    text.startsWith("<") ||
    /^mime-version:/i.test(text)
  );
}

/**
 * Where a relationship in `relsPath` points, as an entry name of this
 * archive, or null when the target cannot be resolved EXACTLY: anything
 * percent-encoded, backslashed, carrying a query, fragment or scheme, or
 * climbing out of the package. What a reader would make of such a target is
 * its own business, and not something to vet on its behalf.
 */
function resolveTarget(relsPath: string, target: string): string | null {
  if (/[%\\?#:\s]/.test(target) || [...target].some((c) => c.charCodeAt(0) < 0x20)) return null;
  const owner = /^(.*?)_rels\/[^/]*\.rels$/i.exec(relsPath);
  const base = owner ? owner[1] : relsPath.slice(0, relsPath.lastIndexOf("/") + 1);
  const segments = (target.startsWith("/") ? target.slice(1) : base + target).split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      if (segment === "") return null;
      continue;
    }
    if (segment === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
    } else resolved.push(segment);
  }
  return resolved.join("/");
}

/**
 * Returns the package with every relationship cut that is external, of a type
 * not on the allow-list (`RENDERED_FROM`), or pointing at something that is
 * not what its type promises — or the SAME buffer when there was nothing to
 * cut (the common case costs no copy and no re-deflate; untouched entries are
 * copied as stored either way).
 *
 * Refuses the package (throws `OfficeFileRejectedError`) when cutting would
 * hide what is really going on: an altChunk anywhere, a DTD in a part
 * LibreOffice parses, or a part the allow-list says is Office XML that is
 * something else entirely (HTML, SVG, a nested package…). Those are not real
 * documents with an unlucky link; they are built to be imported.
 *
 * Expects a VERIFIED archive (`verifiedZipCopy`): sizes are taken as true.
 */
export function sanitizeOoxmlPackage(buffer: Buffer): { data: Buffer; removed: number } {
  const entries = readZipEntries(buffer);
  const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  const verdicts = new Map<string, boolean>();

  const contentTypes = byName.get("[content_types].xml");
  if (
    contentTypes &&
    DTD.test(inflatePart(buffer, contentTypes, MAX_RELS_BYTES).toString("latin1"))
  ) {
    throw unexpected("the content-types part declares a DOCTYPE");
  }

  /** Is the part at `name` what `kind` promises? Throws to refuse; false to cut. Memoised. */
  const vet = (name: string, kind: TargetClass): boolean => {
    const key = `${kind}:${name.toLowerCase()}`;
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    const entry = byName.get(name.toLowerCase());
    let verdict: boolean;
    if (!entry) verdict = false;
    else if (kind === "xml") verdict = vetXmlPart(buffer, entry);
    else if (kind === "image") verdict = vetImagePart(buffer, entry);
    else verdict = !looksLikeDocument(inflateHead(buffer, entry));
    verdicts.set(key, verdict);
    return verdict;
  };

  const rewritten = new Map<number, Buffer>();
  let removed = 0;

  entries.forEach((entry, index) => {
    if (!/\.rels$/i.test(entry.name)) return;
    const bytes = inflatePart(buffer, entry, MAX_RELS_BYTES);
    // UTF-16 (or anything with NULs) would defeat every text match here while a
    // parser still reads it. A relationship part is ASCII-compatible text.
    if (bytes.includes(0)) throw unexpected("a relationship part is not UTF-8 text");

    const result = filterRelationships(bytes.toString("latin1"), (attributes) => {
      const type = attributes.get("Type") ?? "";
      if (AFCHUNK.has(type)) refuseAltChunk();
      if (!isInternal(attributes)) return false;
      const kind = RENDERED_FROM.get(type);
      if (!kind) return false;
      const target = resolveTarget(entry.name, attributes.get("Target")!);
      return target !== null && vet(target, kind);
    });
    if (result.removed === 0) return;
    removed += result.removed;
    rewritten.set(index, Buffer.from(result.xml, "latin1"));
  });

  if (removed === 0) return { data: buffer, removed: 0 };

  return {
    data: assembleZip(
      entries.map((entry, index) => {
        const replacement = rewritten.get(index);
        return replacement ? deflatedPart(entry.name, replacement) : rawPart(buffer, entry);
      })
    ),
    removed,
  };
}

/** Up to the first 4 KiB of an entry, inflating no more than that. */
function inflateHead(archive: Buffer, entry: ZipEntryInfo): Buffer {
  return inflatePart(archive, entry, Math.min(entry.uncompressedSize, 4096), { partial: true });
}

/**
 * An Office XML part, or a refusal: a part an allow-listed relationship
 * calls XML that is not OOXML is not a document with a broken link — it is
 * built to be imported as something else (HTML, SVG, flat ODF, a package).
 */
function vetXmlPart(archive: Buffer, entry: ZipEntryInfo): true {
  const bytes = inflatePart(archive, entry, entry.uncompressedSize);
  const notOoxml = (what: string) =>
    unexpected(`part "${entry.name}" should be Office XML but ${what}`);
  if (bytes.includes(0)) throw notOoxml("is not UTF-8 text");
  const text = bytes.toString("latin1");
  if (DTD.test(text)) throw notOoxml("declares a DOCTYPE");
  const root = rootElement(text);
  if (!root || root.namespace === undefined || !OOXML_NAMESPACE.test(root.namespace)) {
    throw notOoxml("is something else");
  }
  if (ALT_CHUNK.test(text)) refuseAltChunk();
  return true;
}

/** A picture we will let LibreOffice draw; anything else is cut (the picture is not drawn). */
function vetImagePart(archive: Buffer, entry: ZipEntryInfo): boolean {
  const head = inflateHead(archive, entry);
  if (isRasterOrMetafile(head)) return true;
  if (!/<svg[\s>]/i.test(head.toString("latin1"))) return false;
  if (entry.uncompressedSize > MAX_SVG_BYTES) return false;
  const svg = inflatePart(archive, entry, entry.uncompressedSize);
  return !svg.includes(0) && isSelfContainedSvg(svg.toString("latin1"));
}

/**
 * Reads `absPath` once, checks it, and returns the bytes to convert.
 *
 * The caller stages THESE bytes rather than a link to the original: the file
 * sits on a share its planter can still write to, and a symlink would let it
 * change between the check and the conversion.
 *
 * @throws OfficeFileRejectedError when the file must not be handed to a reader.
 */
export async function prepareOfficeSource(
  absPath: string,
  opts: PreflightOptions = {}
): Promise<PreparedSource> {
  const buffer = await readCapped(absPath, opts.maxBytes ?? OFFICE_MAX_FILE_BYTES);
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const ext = extname(absPath).toLowerCase();

  const container = sniffContainer(buffer);
  if (container === null || !allowedContainers(absPath).includes(container)) {
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `the content of this ${ext} file is not a Word or PowerPoint document`
    );
  }
  if (container !== "zip") return { data: buffer, relationshipsRemoved: 0, contentHash };

  // Everything from here on reads the VERIFIED copy, and the copy (or its
  // sanitized rewrite) is what is staged: LibreOffice never sees a byte of the
  // original archive that the guard did not inflate and check.
  const verified = await verifiedCopy(buffer, OOXML_LIMITS, "Office Open XML package");
  try {
    const entries = readZipEntries(verified);
    if (!entries.some((entry) => entry.name === "[Content_Types].xml")) {
      throw new OfficeFileRejectedError(
        "unexpected_content",
        `this ${ext} file is a zip, but not an Office Open XML package`
      );
    }
    const { data, removed } = sanitizeOoxmlPackage(verified);
    return { data, relationshipsRemoved: removed, contentHash };
  } catch (err) {
    if (err instanceof OfficeFileRejectedError) throw err;
    // A corrupt central directory: not a package, and not worth a reader's time.
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `this ${ext} file is not a valid Office Open XML package`
    );
  }
}

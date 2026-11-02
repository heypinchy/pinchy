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
 * bytes can declare gigabytes. The central directory is read — nothing is
 * inflated — through the guard `pinchy-files` already uses for `.docx` (#424),
 * with a ratio rule on top and a cap on the file itself.
 *
 * ## 3. Does it ask LibreOffice to fetch something?
 *
 * An `a:blip r:link` points at a relationship, and a relationship marked
 * `TargetMode="External"` is a URL. LibreOffice fetches `http(s)://` ones
 * (an SSRF from inside the container) and EMBEDS `file://` ones into the PDF
 * (a local-file read, served to every reader of the knowledge base). The
 * profile LibreOffice runs with is locked down as well (see `office-convert.ts`),
 * but that is one setting in someone else's code. This removes the thing the
 * setting would have to catch: every external relationship is cut from a COPY
 * of the package before conversion. The document text survives; the linked
 * picture, the template, the hyperlink's destination do not — none of which
 * the PDF's text layer ever carried.
 *
 * **Every** external relationship goes, hyperlinks included. A first version
 * spared `hyperlink` and was wrong: LibreOffice resolves an `r:link` id
 * WITHOUT checking the relationship's Type, so a hyperlink-labelled
 * relationship used as a picture link fetched exactly like an image one
 * (measured, 3 requests).
 */
import { open, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";

import {
  assertZipWithinLimits,
  ZipLimitError,
  type ZipLimits,
} from "../../../../plugins/pinchy-files/docx-zip-guard";

import { OfficeFileRejectedError, isPresentationFile } from "./office-formats";
import { assembleZip, deflatedPart, inflatePart, rawPart, readZipEntries } from "./office-zip";

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
  /** External relationships cut from the package; 0 when it was handed through as it was. */
  externalLinksRemoved: number;
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

/** Runs the shared central-directory guard; a LIMIT violation becomes a refusal, anything else propagates. */
function enforceLimits(buffer: Buffer, limits: ZipLimits): void {
  try {
    assertZipWithinLimits(buffer, limits);
  } catch (err) {
    if (err instanceof ZipLimitError) throw new OfficeFileRejectedError("too_large", err.message);
    throw err;
  }
}

/**
 * The workbook's bytes, read once and vetted against the limits — the buffer is
 * what exceljs is then given, so the file it parses is the file that was
 * checked.
 *
 * Only LIMIT violations are refused here. A file that is not a zip at all is
 * handed on untouched: exceljs's own diagnosis ("could not be opened as a
 * workbook") is the existing contract for that and already says the right
 * thing.
 */
export async function readWorkbookBuffer(
  absPath: string,
  opts: PreflightOptions = {}
): Promise<Buffer> {
  const buffer = await readCapped(absPath, opts.maxBytes ?? XLSX_MAX_FILE_BYTES);
  try {
    enforceLimits(buffer, XLSX_LIMITS);
  } catch (err) {
    if (err instanceof OfficeFileRejectedError) throw err;
  }
  return buffer;
}

/** The `.docx` bytes for the word-count oracle, vetted the same way as the conversion input. */
export async function readGuardedDocx(absPath: string): Promise<Buffer> {
  const buffer = await readCapped(absPath, OFFICE_MAX_FILE_BYTES);
  enforceLimits(buffer, OOXML_LIMITS);
  return buffer;
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
// 3. Does it ask LibreOffice to fetch something?
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

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    if (!attributes.has(match[1])) attributes.set(match[1], match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/**
 * Is this relationship one we leave in? Only a plainly internal one: a target
 * mode that is absent or exactly `Internal`, and a target that is a relative
 * part path. Everything else — External, an unfamiliar mode, an entity (`&`)
 * that an XML parser would decode into something else, a target carrying a
 * scheme — is cut. Conservative by construction: the cost of a false positive
 * is a missing picture, the cost of a false negative is a request.
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

/**
 * Removes every relationship that is not plainly internal from a `.rels` part.
 * Works on the text of the part (decoded as latin1, so the round trip is
 * byte-exact for whatever encoding it declared).
 */
export function stripExternalRelationships(xml: string): { xml: string; removed: number } {
  let out = "";
  let cursor = 0;
  let removed = 0;

  const malformed = () =>
    new OfficeFileRejectedError("unexpected_content", "a relationship part is not well-formed");

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
    if (isInternal(attributesOf(tag))) {
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
 * Returns the package with every external relationship cut, or the SAME buffer
 * when there was nothing to cut (the common case costs no copy and no
 * re-deflate; untouched entries are copied as stored either way).
 */
export function sanitizeOoxmlPackage(buffer: Buffer): { data: Buffer; removed: number } {
  const entries = readZipEntries(buffer);
  const rewritten = new Map<string, Buffer>();
  let removed = 0;

  entries.forEach((entry, index) => {
    if (!/\.rels$/i.test(entry.name)) return;
    const bytes = inflatePart(buffer, entry, MAX_RELS_BYTES);
    // UTF-16 (or anything with NULs) would defeat every text match here while a
    // parser still reads it. A relationship part is ASCII-compatible text.
    if (bytes.includes(0)) {
      throw new OfficeFileRejectedError(
        "unexpected_content",
        "a relationship part is not UTF-8 text"
      );
    }
    const result = stripExternalRelationships(bytes.toString("latin1"));
    if (result.removed === 0) return;
    removed += result.removed;
    rewritten.set(String(index), Buffer.from(result.xml, "latin1"));
  });

  if (removed === 0) return { data: buffer, removed: 0 };

  return {
    data: assembleZip(
      entries.map((entry, index) => {
        const replacement = rewritten.get(String(index));
        return replacement ? deflatedPart(entry.name, replacement) : rawPart(buffer, entry);
      })
    ),
    removed,
  };
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
  const ext = extname(absPath).toLowerCase();

  const container = sniffContainer(buffer);
  if (container === null || !allowedContainers(absPath).includes(container)) {
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `the content of this ${ext} file is not a Word or PowerPoint document`
    );
  }
  if (container !== "zip") return { data: buffer, externalLinksRemoved: 0 };

  try {
    enforceLimits(buffer, OOXML_LIMITS);
    const entries = readZipEntries(buffer);
    if (!entries.some((entry) => entry.name === "[Content_Types].xml")) {
      throw new OfficeFileRejectedError(
        "unexpected_content",
        `this ${ext} file is a zip, but not an Office Open XML package`
      );
    }
    const { data, removed } = sanitizeOoxmlPackage(buffer);
    return { data, externalLinksRemoved: removed };
  } catch (err) {
    if (err instanceof OfficeFileRejectedError) throw err;
    // A corrupt central directory: not a package, and not worth a reader's time.
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `this ${ext} file is not a valid Office Open XML package`
    );
  }
}

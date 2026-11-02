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
 * carried. An altChunk is cut too — relationship and element — and that one
 * does cost text (the chunk's own), so the converter logs it.
 *
 * **Every** external relationship goes, hyperlinks included. A first version
 * spared `hyperlink` and was wrong: LibreOffice resolves an `r:link` id
 * WITHOUT checking the relationship's Type, so a hyperlink-labelled
 * relationship used as a picture link fetched exactly like an image one
 * (measured, 3 requests). The same fact is why a kept relationship's TARGET is
 * vetted by its bytes, not its type: an `r:embed` naming a "font" or an
 * "Office part" whose bytes are SVG is drawn as SVG (second review, PR #1243).
 *
 * The same is true one level down: a metafile picture (EMF, WMF) passes on
 * its magic bytes, but its records can carry a picture of their own, which
 * LibreOffice again detects by ITS bytes. So a metafile is walked record by
 * record (third review, PR #1243). One that carries a picture keeps its
 * second, plain drawing where it has one — the EMF records of an "EMF+ Dual"
 * file, the WMF records around an embedded EMF — words included; one that
 * has none is cut, and its words with it (fourth review).
 *
 * RTF (accepted under a `.doc` name, because Word writes those) has its
 * picture, object and field-instruction groups cut (`sanitizeRtf`), and is
 * refused where this tokenizer and LibreOffice's could disagree about where a
 * group ends. The legacy binary formats (`.doc`, `.ppt`) cannot be rewritten
 * here at all; for them the locked profile is the only layer, and it does NOT
 * stop an embedded SVG picture from reading a local file. The canary
 * (`office-convert.canary.libreoffice.test.ts`) says so per vector.
 *
 * What this module is, stated plainly: DEFENCE IN DEPTH, not a boundary. It
 * closes every vector the release reviews found, each pinned by a test, and
 * it errs towards cutting or refusing what it cannot read unambiguously. But
 * it is a rewrite of formats LibreOffice reads in more ways than any list
 * here, and the next way LibreOffice draws something by its bytes is a gap
 * until someone finds it. What closes the family is isolating the converter
 * itself (no network, no view of the workspaces): the office-converter
 * sidecar, `office-converter-sidecar.ts`.
 *
 * Every scan here is a single forward pass over the bytes: a regex that
 * backtracks on a hostile file blocks the web process the KB worker runs in.
 */
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";

import {
  MAX_DOCX_ENTRY_BYTES,
  MAX_DOCX_MARKUP_BYTES,
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

/**
 * The largest single part of a workbook we let exceljs read. Its cell model
 * costs ~20x the sheet XML, and the reader's child process (xlsx-isolated.ts)
 * has a 384 MB heap. Measured in the shipped image under a 1 GB container
 * limit, sheets of numeric rows (fourth review, PR #1243):
 *
 *   sheet XML    peak RSS of the reader
 *   8 MiB        219 MB
 *   16 MiB       350 MB
 *   24 MiB       486 MB
 *   32 MiB       out of heap (568 MB uncapped)
 *
 * 16 MiB — some 40 000 rows of ten columns — leaves the child room beside a
 * server that is itself holding the embedding model. Past it the workbook is
 * refused by its size, before exceljs builds anything; the heap cap stays the
 * backstop for what this cannot see (many parts just under it, the shared
 * strings of all of them at once).
 */
export const XLSX_MAX_PART_BYTES = 16 * MiB;

/** Workbooks: tighter, because the model exceljs builds is heavier than the XML it reads. */
const XLSX_LIMITS: ZipLimits = {
  maxDecompressedBytes: 256 * MiB,
  maxEntryBytes: XLSX_MAX_PART_BYTES,
  ...RATIO_RULE,
};

/**
 * What mammoth (the word-count oracle) may be handed: the conversion's limits,
 * plus a ceiling on any ONE part, plus a ceiling on the MARKUP it parses,
 * summed. mammoth builds a DOM at up to ~300x the XML it reads — a 1.9 MB
 * .docx with a 31 MiB document part peaked at 2.9 GB, in the web process
 * (fourth review, PR #1243) — while a picture costs it nothing. The plugin's
 * own `extractDocxText` uses the same ceilings; `MAX_DOCX_MARKUP_BYTES` has
 * the measurements. Past them the oracle is skipped and the conversion is
 * recorded `unverified`: the oracle is a tripwire, not worth the server.
 */
const MAMMOTH_LIMITS: ZipLimits = {
  ...OOXML_LIMITS,
  maxEntryBytes: MAX_DOCX_ENTRY_BYTES,
  maxMarkupBytes: MAX_DOCX_MARKUP_BYTES,
};

/**
 * The largest single Office XML part the preflight reads — and therefore the
 * largest it lets through to LibreOffice. Relationship parts and the
 * content-types part are held to it too: a 4 MiB cap of their own refused a
 * real catalogue whose 25 000 hyperlinks make a 5.1 MB relationship part, and
 * the filter that reads them is one forward pass (fourth review, PR #1243). Each one is inflated whole into the
 * web process to be checked; the archive's total limit (500 MiB) does not
 * bound that, and a 400 MiB `document.xml` built to stay under the ratio rule
 * took the preflight to 1.3 GB RSS (third review, PR #1243). A thousand-page
 * report's document part is a few MB.
 */
const MAX_XML_PART_BYTES = 64 * MiB;

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
  /**
   * `altChunk` elements cut from an OOXML package. Each one was content in
   * another format (HTML, a nested document) that is now NOT indexed — the
   * converter logs it, because unlike a cut picture link it costs text.
   */
  altChunksRemoved: number;
  /** Picture, object and field-instruction groups cut from an RTF file. */
  rtfGroupsRemoved: number;
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
  const verified = await verifiedCopy(buffer, XLSX_LIMITS, "workbook archive");
  assertReadableNumberFormats(verified);
  return verified;
}

/** Excel caps a number format at 255 characters; this is that, with room to spare — counted DECODED. */
const MAX_FORMAT_CODE_CHARS = 1024;
/** The longest `formatCode` attribute we decode at all, as written: entities make it longer than what it says. */
const MAX_FORMAT_CODE_RAW_CHARS = 16 * 1024;
/** `[` after a format's last `]`: each one costs exceljs a scan to the end of the format, per cell. */
const MAX_UNCLOSED_BRACKETS = 4;

/**
 * Refuses a workbook whose styles part holds a number format exceljs would
 * choke on. exceljs runs `fmt.replace(/\[[^\]]*]/g, '')` on a cell's format
 * for EVERY styled cell it loads (`utils.isDateFmt`), and that regex re-scans
 * to the end of the format from every `[` with no `]` after it: 100 000 such
 * brackets made one load take 4 s, 400 000 two minutes (second review,
 * PR #1243) — in the web process, before our code sees a cell. Excel writes
 * neither a format longer than 255 characters nor a run of unclosed brackets.
 *
 * The format is judged as exceljs's XML parser will hand it over: with its
 * character and entity references DECODED. Counting the attribute as written
 * missed `&#91;`, which is a `[` by the time exceljs sees it — 204 of them in
 * a 1 KiB attribute cost 4.4 s per 200 000 cells (third review, PR #1243).
 *
 * exceljs reads styles from `xl/styles.xml` by that name and no other, so
 * that is the part checked. One linear pass over its `formatCode` attributes.
 */
function assertReadableNumberFormats(archive: Buffer): void {
  let entries: ZipEntryInfo[];
  try {
    entries = readZipEntries(archive);
  } catch {
    return; // Not ours to diagnose: exceljs reports an unreadable archive itself.
  }
  const styles = entries.find((entry) => entry.name.replace(/^\//, "") === "xl/styles.xml");
  if (!styles) return;
  if (styles.uncompressedSize > MAX_XML_PART_BYTES) {
    throw new OfficeFileRejectedError(
      "too_large",
      `this workbook's styles part is ${styles.uncompressedSize} bytes, past the ${MAX_XML_PART_BYTES}-byte limit`
    );
  }
  const xml = inflatePart(archive, styles, styles.uncompressedSize).toString("latin1");
  const refuse = () =>
    new OfficeFileRejectedError(
      "unexpected_content",
      "this workbook declares a number format no spreadsheet application writes"
    );
  let at = 0;
  while ((at = xml.indexOf("formatCode", at)) !== -1) {
    at += "formatCode".length;
    while (isXmlSpace(xml[at])) at++;
    if (xml[at] !== "=") continue;
    at++;
    while (isXmlSpace(xml[at])) at++;
    const quote = xml[at];
    if (quote !== '"' && quote !== "'") continue;
    const close = xml.indexOf(quote, at + 1);
    if (close < 0) throw refuse();
    const raw = xml.slice(at + 1, close);
    at = close + 1;
    if (raw.length > MAX_FORMAT_CODE_RAW_CHARS) throw refuse();
    const value = decodeXmlReferences(raw);
    if (value.length > MAX_FORMAT_CODE_CHARS) throw refuse();
    let unclosed = 0;
    for (let i = value.lastIndexOf("]") + 1; i < value.length; i++) {
      if (value[i] === "[" && ++unclosed > MAX_UNCLOSED_BRACKETS) throw refuse();
    }
  }
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/**
 * An attribute value as an XML parser reports it: character references
 * (`&#91;`, `&#x5B;`, `&#0000091;` — leading zeros are legal, so a reference
 * has no fixed length) and the five predefined entities decoded, everything
 * else as written. One forward pass: a reference is read up to the first
 * character that cannot be part of one, and the next `&` is past it.
 */
function decodeXmlReferences(raw: string): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  let at = 0;
  for (;;) {
    const amp = raw.indexOf("&", at);
    if (amp < 0) return out + raw.slice(at);
    out += raw.slice(at, amp);
    let end = amp + 1;
    while (end < raw.length && isReferenceChar(raw.charCodeAt(end))) end++;
    const name = raw[end] === ";" ? raw.slice(amp + 1, end) : null;
    const semi = end;
    let decoded: string | undefined;
    if (name !== null && /^#[0-9]+$/.test(name)) decoded = fromCodePoint(Number(name.slice(1)));
    else if (name !== null && /^#x[0-9a-fA-F]+$/.test(name))
      decoded = fromCodePoint(parseInt(name.slice(2), 16));
    else if (name !== null) decoded = PREDEFINED_ENTITIES[name];
    if (decoded === undefined) {
      out += "&";
      at = amp + 1;
    } else {
      out += decoded;
      at = semi + 1;
    }
  }
}

/** `#`, an ASCII letter or a digit: what a character or entity reference is spelled with. */
const isReferenceChar = (c: number) =>
  c === 0x23 || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** The character a numeric reference names, or a replacement for one no parser would accept. */
function fromCodePoint(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
}

/**
 * The `.docx` bytes for the word-count oracle, verified like the conversion
 * input and held to mammoth's per-part ceiling on top. A refusal here only
 * leaves the conversion unverified; it never fails it.
 */
export async function readGuardedDocx(absPath: string): Promise<Buffer> {
  const buffer = await readCapped(absPath, OFFICE_MAX_FILE_BYTES);
  return verifiedCopy(buffer, MAMMOTH_LIMITS, "Office Open XML package");
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
/** Starts with a URI scheme, or is a UNC / protocol-relative path. */
const SCHEME_OR_NETWORK_PATH = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\\\\|\/\/)/;
/** A DTD can define entities, and an entity can spell markup no text match sees. No Office writer emits one. */
const DTD = /<!(?:DOCTYPE|ENTITY)/i;

/**
 * The longest start tag we read: a relationship, an altChunk, a part's root
 * element. A real one is a few hundred bytes (Word's busiest root, with every
 * namespace it declares, is about 4 KiB). Anything longer is refused rather
 * than read: it bounds what one tag can cost, whatever reads it.
 */
const MAX_TAG_CHARS = 16 * 1024;

const isXmlSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * The index of the `>` that ends the start tag opening at `from`, honouring
 * quotes so a `>` inside an attribute value cannot end it early. -1 when there
 * is none within `MAX_TAG_CHARS` — no end, or a tag too long to be real.
 * Never reads further than that, so a caller looping over tags stays linear.
 */
function tagEnd(xml: string, from: number): number {
  const limit = Math.min(xml.length, from + MAX_TAG_CHARS);
  let quote = "";
  for (let at = from + 1; at < limit; at++) {
    const c = xml[at];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return at;
  }
  return -1;
}

/**
 * The attributes of one start tag (`<name a="1" b='2'>` or `…/>`), or null
 * when the tag is not well-formed: an attribute without a quoted value,
 * attributes not separated by whitespace, stray characters, or the same name
 * twice (which one a parser keeps is not ours to guess).
 *
 * One forward pass. It replaced a global regex whose `[^\s=/>]+` re-scanned a
 * long token from every offset — quadratic: one 50 000-character token in a
 * 942-byte .docx held the web process for 2.7 s (second review, PR #1243).
 */
function attributesOf(tag: string): Map<string, string> | null {
  let at = 1;
  while (at < tag.length && !isXmlSpace(tag[at]) && tag[at] !== "/" && tag[at] !== ">") at++;
  const attributes = new Map<string, string>();
  for (;;) {
    const before = at;
    while (isXmlSpace(tag[at])) at++;
    const c = tag[at];
    if (c === ">") return at === tag.length - 1 ? attributes : null;
    if (c === "/") return at === tag.length - 2 && tag[at + 1] === ">" ? attributes : null;
    if (c === undefined || at === before) return null;

    const nameStart = at;
    while (at < tag.length && !isXmlSpace(tag[at]) && !"=/>\"'<".includes(tag[at])) at++;
    if (at === nameStart) return null;
    const name = tag.slice(nameStart, at);
    while (isXmlSpace(tag[at])) at++;
    if (tag[at] !== "=") return null;
    at++;
    while (isXmlSpace(tag[at])) at++;
    const quote = tag[at];
    if (quote !== '"' && quote !== "'") return null;
    const close = tag.indexOf(quote, at + 1);
    if (close < 0 || attributes.has(name)) return null;
    attributes.set(name, tag.slice(at + 1, close));
    at = close + 1;
  }
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

    // No end (or none within MAX_TAG_CHARS) means the part is not well-formed
    // XML, or not a real one — refused outright, which is also what keeps this
    // pass linear.
    const close = tagEnd(xml, at);
    if (close < 0) throw malformed();

    const tag = xml.slice(at, close + 1);
    const attributes = attributesOf(tag);
    if (!attributes) throw malformed();
    let end = close + 1;
    if (keep(attributes)) {
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
 * `audio`/`video`/`media`, mail-merge sources, web extensions, signatures —
 * and `aFChunk`, whose `<w:altChunk>` element is cut along with it (see
 * `removeAltChunks`).
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

/** The namespaces an OOXML part's root element may live in. */
const OOXML_NAMESPACE =
  /^(?:http:\/\/schemas\.openxmlformats\.org\/|http:\/\/purl\.oclc\.org\/ooxml\/|http:\/\/schemas\.microsoft\.com\/office\/)/;

/**
 * The local names an Office part's root element may have: the root of every
 * part type on the allow-list, in WordprocessingML, PresentationML,
 * DrawingML, the package properties and Microsoft's extensions. A namespace
 * alone is not enough (second review, PR #1243): `<svg xmlns="http://schemas.microsoft.com/office/…">`
 * is in an Office namespace, and LibreOffice drew it as an SVG — which read a
 * local file — when a picture's `r:embed` named it.
 */
const OOXML_ROOT_NAMES = new Set([
  // WordprocessingML
  "document",
  "styles",
  "numbering",
  "fonts",
  "settings",
  "webSettings",
  "hdr",
  "ftr",
  "footnotes",
  "endnotes",
  "comments",
  "glossaryDocument",
  "people",
  "commentsEx",
  "commentsIds",
  "commentsExtensible",
  // PresentationML
  "presentation",
  "sld",
  "sldLayout",
  "sldMaster",
  "notes",
  "notesMaster",
  "handoutMaster",
  "presentationPr",
  "viewPr",
  "cmAuthorLst",
  "cmLst",
  "authorLst",
  // DrawingML: themes, table styles, charts, SmartArt
  "theme",
  "themeOverride",
  "tblStyleLst",
  "chartSpace",
  "userShapes",
  "chartStyle",
  "colorStyle",
  "dataModel",
  "layoutDef",
  "styleDef",
  "colorsDef",
  "drawing",
  // Package properties
  "coreProperties",
  "Properties",
]);

/**
 * SVG markup, or a DTD, in the first bytes of a part. LibreOffice's picture
 * detection takes a part for SVG when it finds the BYTES `<svg` anywhere in
 * its first 2 KiB (or an XML declaration, a DOCTYPE and `svg`), whatever the
 * relationship called it. Looking at 4 KiB, case-insensitively, is the
 * superset of that — and so is a prefixed element whose local name is exactly
 * `svg` (`<s:svg`), which no detector's byte match would see but an XML
 * reader resolving namespaces would.
 *
 * EXACTLY `svg`, for a prefixed name: `<asvg:svgBlip>` is what Office 365 and
 * LibreOffice write next to every SVG picture (and every PowerPoint Icon),
 * and the first version of this pattern — `svg` after ANY prefix, as a prefix
 * of the local name — refused every such document (third review, PR #1243).
 * Unprefixed, `<svg` stays a byte match, as it is for LibreOffice: `<svgx>`
 * is taken for SVG too.
 */
const SVG_MARKUP = /<svg|<[A-Za-z_][\w.-]*:svg(?=[\s/>])|<!DOCTYPE/i;

/** Would LibreOffice's picture detection take these first bytes for SVG — or gzip, i.e. SVGZ? */
function looksLikeSvg(head: Buffer): boolean {
  if (head[0] === 0x1f && head[1] === 0x8b) return true;
  // NULs dropped: a UTF-16 spelling must not hide the markup from this check.
  return SVG_MARKUP.test(head.subarray(0, 4096).toString("latin1").replace(/\0/g, ""));
}

/** `<w:altChunk`, any prefix, as a candidate the scanner then reads properly. */
const ALT_CHUNK_START = /<((?:[A-Za-z_][\w.-]*:)?altChunk)(?=[\s/>])/g;

/**
 * Removes every `altChunk` element from an Office XML part — the self-closing
 * form and the one with children (`<w:altChunkPr>`) — and says how many.
 *
 * An altChunk imports the part its `r:id` names through a SECOND import filter
 * (HTML, RTF, a nested document), which reads local files the locked profile
 * does not stop (release review v0.10.0). LibreOffice resolves that id without
 * checking the relationship's Type, so cutting the `aFChunk` relationship is
 * not enough: an altChunk can borrow the id of a kept picture. So the element
 * goes. Everything around it stays searchable; the chunk's own content is not
 * indexed, and the converter logs that it was dropped.
 *
 * Linear: each element is read once from where the last one ended. A start
 * tag with no end, or an element with no closing tag, is refused — what
 * follows it is not ours to guess.
 */
function removeAltChunks(xml: string, partName: string): { xml: string; removed: number } {
  const malformed = () => unexpected(`part "${partName}" has an altChunk that is not well-formed`);
  let out = "";
  let cursor = 0;
  let removed = 0;
  ALT_CHUNK_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ALT_CHUNK_START.exec(xml))) {
    const close = tagEnd(xml, match.index);
    if (close < 0) throw malformed();
    let end = close + 1;
    if (xml[close - 1] !== "/") {
      // The first `</w:altChunk` that is that name exactly — `</w:altChunkPr>`
      // starts the same way. Searching only forward keeps this linear.
      const closingTag = `</${match[1]}`;
      let closing = xml.indexOf(closingTag, end);
      while (
        closing >= 0 &&
        !isXmlSpace(xml[closing + closingTag.length]) &&
        xml[closing + closingTag.length] !== ">"
      ) {
        closing = xml.indexOf(closingTag, closing + closingTag.length);
      }
      if (closing < 0) throw malformed();
      let after = closing + closingTag.length;
      while (isXmlSpace(xml[after])) after++;
      if (xml[after] !== ">") throw malformed();
      end = after + 1;
    }
    out += xml.slice(cursor, match.index);
    cursor = end;
    removed++;
    ALT_CHUNK_START.lastIndex = end;
  }
  return removed === 0 ? { xml, removed: 0 } : { xml: out + xml.slice(cursor), removed };
}

/** No SVG picture we keep is anywhere near this; a bigger one is not drawn. */
const MAX_SVG_BYTES = 16 * MiB;

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
  const end = tagEnd(xml, at);
  if (end < 0) return null;
  const attributes = attributesOf(xml.slice(at, end + 1));
  if (!attributes) return null;
  return { name: local, namespace: attributes.get(prefix ? `xmlns:${prefix}` : "xmlns") };
}

const startsWith = (bytes: Buffer, hex: string) =>
  bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));

/**
 * Is `bytes` a picture whose pixels are all it carries, by its magic number?
 * PNG, JPEG, GIF, BMP, TIFF, JPEG XR (`hdphoto`), WebP, ICO. Metafiles are
 * pictures too, but ones that can carry another picture — see `isMetafile`.
 */
function isPixelPicture(bytes: Buffer): boolean {
  const starts = (hex: string) => startsWith(bytes, hex);
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
    starts("4949bc") ||
    starts("00000100") ||
    (starts("52494646") && bytes.subarray(8, 12).toString("latin1") === "WEBP")
  );
}

const isEmf = (bytes: Buffer) =>
  startsWith(bytes, "01000000") && bytes.subarray(40, 44).toString("latin1") === " EMF";

/** WMF: placeable (the Aldus header), or a plain header in memory (1) or on disk (2). */
const isWmf = (bytes: Buffer) =>
  startsWith(bytes, "d7cdc69a") ||
  startsWith(bytes, "010009000003") ||
  startsWith(bytes, "020009000003");

/** A Windows metafile — EMF (with or without EMF+) or WMF — by its magic number. */
const isMetafile = (bytes: Buffer) => isEmf(bytes) || isWmf(bytes);

/** Is `bytes` a raster picture by its magic number — PNG, JPEG, GIF, BMP or WebP — and nothing else? */
function isRaster(bytes: Buffer): boolean {
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  return (
    starts("89504e470d0a1a0a") ||
    starts("ffd8ff") ||
    starts("474946383761") ||
    starts("474946383961") ||
    starts("424d") ||
    (starts("52494646") && bytes.subarray(8, 12).toString("latin1") === "WEBP")
  );
}

const SVG_HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)/gi;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|bmp|webp);base64,([A-Za-z0-9+/=\s]*)$/;
/** An HTML island inside an SVG: it can carry references of its own (`<img src>`). */
const FOREIGN_OBJECT = /<(?:[A-Za-z_][\w.-]*:)?foreignObject(?=[\s/>])/i;

/**
 * A `data:` URL's picture is what its BYTES are, not what its media type
 * says: LibreOffice detects the format from the decoded content. The
 * reviewer's `data:image/png;base64,` holding an SVG (or a gzipped one) was
 * drawn as SVG and read a local file. So the bytes must be a raster, and not
 * one that also carries SVG markup up front.
 */
function isEmbeddedRaster(value: string): boolean {
  const match = DATA_IMAGE.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[1], "base64");
  return isRaster(bytes) && !looksLikeSvg(bytes);
}

/**
 * Does this SVG reference nothing outside itself? Every `href` must be a
 * fragment of this same file or an embedded raster, every CSS `url()` a
 * fragment; no stylesheet imports, no DTD, no entities hiding a reference,
 * no `foreignObject`.
 *
 * Measured against LibreOffice 26.2 under the locked profile: an internal SVG
 * picture with `<image href="file:///…">` drew the local file into the PDF —
 * a local PNG embedded, a local SVG's text in the indexed text layer.
 */
function isSelfContainedSvg(text: string): boolean {
  if (DTD.test(text) || /@import/i.test(text) || FOREIGN_OBJECT.test(text)) return false;
  for (const match of text.matchAll(SVG_HREF)) {
    const value = (match[1] ?? match[2]).trim();
    if (value.includes("&")) return false;
    if (!value.startsWith("#") && !isEmbeddedRaster(value)) return false;
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
 * not what its type promises — and every `altChunk` element cut from the
 * Office parts it keeps — or the SAME buffer when there was nothing to cut
 * (the common case costs no copy and no re-deflate; untouched entries are
 * copied as stored either way).
 *
 * A kept target is vetted by what its BYTES are, whatever its relationship
 * says: LibreOffice resolves `r:embed` by Id, never checks the Type, and
 * detects a picture's format from its content. So a part that would be taken
 * for SVG or SVGZ is cut — or refused, for a part that claims to be Office
 * XML — unless it is a picture that passes the self-contained-SVG check.
 *
 * Refuses the package (throws `OfficeFileRejectedError`) when cutting would
 * hide what is really going on: a DTD in a part LibreOffice parses, or a part
 * the allow-list says is Office XML that is something else entirely (HTML,
 * SVG, a nested package…). Those are not real documents with an unlucky
 * link; they are built to be imported.
 *
 * Expects a VERIFIED archive (`verifiedZipCopy`): sizes are taken as true.
 */
export function sanitizeOoxmlPackage(buffer: Buffer): {
  data: Buffer;
  removed: number;
  altChunksRemoved: number;
} {
  const entries = readZipEntries(buffer);
  const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  const verdicts = new Map<string, boolean>();
  /** Parts whose bytes change: relationship parts, and Office parts that held an altChunk. */
  const rewritten = new Map<ZipEntryInfo, Buffer>();
  let altChunksRemoved = 0;

  const contentTypes = byName.get("[content_types].xml");
  if (
    contentTypes &&
    DTD.test(inflatePart(buffer, contentTypes, MAX_XML_PART_BYTES).toString("latin1"))
  ) {
    throw unexpected("the content-types part declares a DOCTYPE");
  }

  /** An Office XML part, or a refusal; any altChunk in it is cut. */
  const vetXmlPart = (entry: ZipEntryInfo): true => {
    if (entry.uncompressedSize > MAX_XML_PART_BYTES) {
      throw new OfficeFileRejectedError(
        "too_large",
        `part "${entry.name}" is ${entry.uncompressedSize} bytes, past the ${MAX_XML_PART_BYTES}-byte limit for one part`
      );
    }
    const bytes = inflatePart(buffer, entry, MAX_XML_PART_BYTES);
    const notOoxml = (what: string) =>
      unexpected(`part "${entry.name}" should be Office XML but ${what}`);
    if (bytes.includes(0)) throw notOoxml("is not UTF-8 text");
    const text = bytes.toString("latin1");
    if (DTD.test(text)) throw notOoxml("declares a DOCTYPE");
    const root = rootElement(text);
    if (
      !root ||
      root.namespace === undefined ||
      !OOXML_NAMESPACE.test(root.namespace) ||
      !OOXML_ROOT_NAMES.has(root.name)
    ) {
      throw notOoxml("is something else");
    }
    if (looksLikeSvg(bytes)) throw notOoxml("would be drawn as an SVG picture");
    const result = removeAltChunks(text, entry.name);
    if (result.removed > 0) {
      altChunksRemoved += result.removed;
      rewritten.set(entry, Buffer.from(result.xml, "latin1"));
    }
    return true;
  };

  /** Is the part at `name` what `kind` promises? Throws to refuse; false to cut. Memoised. */
  const vet = (name: string, kind: TargetClass): boolean => {
    const key = `${kind}:${name.toLowerCase()}`;
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    const entry = byName.get(name.toLowerCase());
    let verdict: boolean;
    if (!entry) verdict = false;
    else if (kind === "xml") verdict = vetXmlPart(entry);
    else if (kind === "image") {
      const kept = vetImagePart(buffer, entry);
      verdict = kept !== null;
      // A metafile kept without the layer that reached for a picture.
      if (kept instanceof Buffer) rewritten.set(entry, kept);
    } else {
      // A font is drawn as a picture when an `r:embed` names it, and then by
      // what its bytes are: a metafile carrying a picture is one (third
      // review). An obfuscated font's first 32 bytes are scrambled, so none of
      // these magic numbers turns up in a real one.
      const head = inflateHead(buffer, entry);
      verdict = !looksLikeDocument(head) && !looksLikeSvg(head) && !isMetafile(head);
    }
    verdicts.set(key, verdict);
    return verdict;
  };

  let removed = 0;

  for (const entry of entries) {
    if (!/\.rels$/i.test(entry.name)) continue;
    const bytes = inflatePart(buffer, entry, MAX_XML_PART_BYTES);
    // UTF-16 (or anything with NULs) would defeat every text match here while a
    // parser still reads it. A relationship part is ASCII-compatible text.
    if (bytes.includes(0)) throw unexpected("a relationship part is not UTF-8 text");

    const result = filterRelationships(bytes.toString("latin1"), (attributes) => {
      if (!isInternal(attributes)) return false;
      const kind = RENDERED_FROM.get(attributes.get("Type") ?? "");
      if (!kind) return false;
      const target = resolveTarget(entry.name, attributes.get("Target")!);
      return target !== null && vet(target, kind);
    });
    if (result.removed === 0) continue;
    removed += result.removed;
    rewritten.set(entry, Buffer.from(result.xml, "latin1"));
  }

  if (rewritten.size === 0) return { data: buffer, removed: 0, altChunksRemoved: 0 };

  return {
    data: assembleZip(
      entries.map((entry) => {
        const replacement = rewritten.get(entry);
        return replacement ? deflatedPart(entry.name, replacement) : rawPart(buffer, entry);
      })
    ),
    removed,
    altChunksRemoved,
  };
}

/** Up to the first 4 KiB of an entry, inflating no more than that. */
function inflateHead(archive: Buffer, entry: ZipEntryInfo): Buffer {
  return inflatePart(archive, entry, Math.min(entry.uncompressedSize, 4096), { partial: true });
}

/**
 * A picture we will let LibreOffice draw: `true` to keep it as it is, a
 * Buffer to keep THAT instead (a metafile without the layer that reached for
 * a picture), `null` to cut it (the picture is not drawn). Whatever would be
 * taken for SVG is held to the SVG rule — raster magic up front does not
 * excuse SVG markup behind it — and SVGZ is never kept: what it reaches for
 * cannot be read without inflating it whole. A metafile is walked record by
 * record (`keptMetafile`).
 */
function vetImagePart(archive: Buffer, entry: ZipEntryInfo): true | Buffer | null {
  const keepIf = (ok: boolean) => (ok ? true : null);
  const head = inflateHead(archive, entry);
  if (!looksLikeSvg(head)) {
    if (!isMetafile(head)) return keepIf(isPixelPicture(head));
    if (entry.uncompressedSize > MAX_METAFILE_BYTES) return null;
    const bytes = inflatePart(archive, entry, MAX_METAFILE_BYTES);
    const kept = keptMetafile(bytes);
    return kept === bytes ? true : kept;
  }
  if (head[0] === 0x1f && head[1] === 0x8b) return null;
  if (entry.uncompressedSize > MAX_SVG_BYTES) return null;
  const svg = inflatePart(archive, entry, entry.uncompressedSize);
  return keepIf(!svg.includes(0) && isSelfContainedSvg(svg.toString("latin1")));
}

// --- Metafiles ------------------------------------------------------------

/**
 * The largest metafile picture we walk. Clip art and charts are kilobytes to a
 * few MB; a bigger one is not drawn (cut), rather than read whole.
 */
const MAX_METAFILE_BYTES = 16 * MiB;

const EMR_HEADER = 1;
const EMR_EOF = 14;
const EMR_COMMENT = 70;
/**
 * EMF records that name a file or hand data to a device or another filter:
 * colour-space and ICM-profile records (a profile FILE NAME), and the escape
 * records (PostScript and other passthrough). No ordinary picture needs them
 * to be drawn.
 */
const EMF_RECORDS_CUT = new Set([
  99, // EMR_CREATECOLORSPACE
  105, // EMR_DRAWESCAPE
  106, // EMR_EXTESCAPE
  110, // EMR_NAMEDESCAPE
  112, // EMR_SETICMPROFILEA
  113, // EMR_SETICMPROFILEW
  121, // EMR_COLORMATCHTOTARGETW
  122, // EMR_CREATECOLORSPACEW
]);

const COMMENT_EMF_PLUS = 0x2b464d45; // "EMF+"
const COMMENT_PUBLIC = 0x43494447; // "GDIC"
const COMMENT_EMF_SPOOL = 0x00000000;
/** Public comments that only group records or label them. MULTIFORMATS (an embedded EMF or EPS) and WINDOWS_METAFILE (an embedded WMF) are not among them. */
const PUBLIC_COMMENTS_KEPT = new Set([0x00000002, 0x00000003, 0x00000040, 0x00000080]);

const EMF_PLUS_OBJECT = 0x4008;
const EMF_PLUS_OBJECT_BRUSH = 1;
const EMF_PLUS_OBJECT_PEN = 2;
const EMF_PLUS_OBJECT_IMAGE = 5;
const EMF_PLUS_BRUSH_TEXTURE = 2;
const EMF_PLUS_CONTINUED = 0x8000;

/** The EmfPlusHeader record, and its flag for "EMF+ Dual" ([MS-EMFPLUS] 2.3.3.3). */
const EMF_PLUS_HEADER = 0x4001;
const EMF_PLUS_DUAL = 0x0001;

/**
 * What to keep of a metafile picture: the bytes themselves when they carry
 * no picture of their own (`metafileCarriesNoPicture`); a copy without the
 * layer that does, when the rest still draws the whole picture; or null, to
 * cut it.
 *
 * Cutting costs words. A metafile's text is GDI text records, LibreOffice
 * draws them into the PDF's text layer, and the index reads that layer — so
 * a cut chart lost its labels from search (fourth review, PR #1243). Two
 * shapes have a second, complete drawing to fall back to:
 *
 *  - An "EMF+ Dual" EMF — what Office and LibreOffice write whenever they
 *    write EMF+ — draws everything twice: once in EMF+ records (inside
 *    comments), once in ordinary EMF records for readers without EMF+. When
 *    the EMF+ layer is what carries a picture, EVERY EMF+ comment goes and
 *    the EMF records stay: LibreOffice then draws the file as the plain EMF
 *    it also is. Partial removal is not attempted — one comment batches many
 *    EMF+ records, and a half-present EMF+ layer is a drawing nobody wrote.
 *  - A WMF that carries an EMF ("WMFC" comments, Office's and LibreOffice's
 *    habit): LibreOffice draws the EMF instead of the WMF records around it.
 *    When the EMF is what carries a picture (or is not all there), the WMFC
 *    records go and the WMF's own records — the same drawing — stay.
 *
 * The rewrite drops whole records and fixes the counts the header keeps
 * (an EMF's byte and record count, a WMF's size and largest record); nothing
 * else in either format points at a record's position. The result is walked
 * again like any metafile and cut if it is not plain. An EMF+ file that is
 * NOT dual has no second drawing, and is cut as before — with its words.
 */
function keptMetafile(bytes: Buffer): Buffer | null {
  if (metafileCarriesNoPicture(bytes)) return bytes;
  try {
    const fallback = isEmf(bytes) ? emfWithoutEmfPlus(bytes) : wmfWithoutEmbeddedEmf(bytes);
    return fallback && metafileCarriesNoPicture(fallback) ? fallback : null;
  } catch {
    return null; // Read past the end: a record lied about its size.
  }
}

const isEmfPlusComment = (record: Buffer) =>
  record.readUInt32LE(0) === EMR_COMMENT &&
  record.length >= 16 &&
  record.readUInt32LE(8) >= 4 &&
  record.readUInt32LE(12) === COMMENT_EMF_PLUS;

/**
 * This EMF without any of its EMF+ comments — only if it is "EMF+ Dual" (the
 * flag on the EMF+ header, the first EMF+ record of the first EMF+ comment),
 * and with the header's byte and record counts set to what is left. Null for
 * anything else.
 */
function emfWithoutEmfPlus(emf: Buffer): Buffer | null {
  const kept: Buffer[] = [];
  let dual: boolean | null = null;
  for (let at = 0; at < emf.length;) {
    const size = emf.readUInt32LE(at + 4);
    if (size < 8 || size % 4 !== 0 || at + size > emf.length) return null;
    const record = emf.subarray(at, at + size);
    at += size;
    if (!isEmfPlusComment(record)) {
      kept.push(record);
      continue;
    }
    if (dual === null) {
      if (record.length < 28 || record.readUInt16LE(16) !== EMF_PLUS_HEADER) return null;
      dual = (record.readUInt16LE(18) & EMF_PLUS_DUAL) !== 0;
    }
  }
  // The header record carries nBytes at 48 and nRecords at 52.
  if (!dual || kept.length === 0 || kept[0].length < 56) return null;
  const out = Buffer.concat(kept);
  out.writeUInt32LE(out.length, 48);
  out.writeUInt32LE(kept.length, 52);
  return out;
}

/**
 * This WMF without its "WMFC" records (the EMF it carries), with its header's
 * size and largest-record fields set to what is left. Null when there were
 * none, or the records cannot be walked.
 */
function wmfWithoutEmbeddedEmf(wmf: Buffer): Buffer | null {
  const start = startsWith(wmf, "d7cdc69a") ? 22 : 0;
  if (start + 18 > wmf.length || wmf.readUInt16LE(start + 2) !== 9) return null;
  const kept: Buffer[] = [];
  let dropped = 0;
  let largest = 0;
  for (let at = start + 18; at < wmf.length;) {
    const size = wmf.readUInt32LE(at) * 2;
    if (size < 6 || at + size > wmf.length) return null;
    const record = wmf.subarray(at, at + size);
    at += size;
    const embedsEmf =
      record.readUInt16LE(4) === META_ESCAPE &&
      size >= 14 &&
      record.readUInt16LE(6) === MFCOMMENT &&
      record.readUInt32LE(10) === WMF_EMBEDDED_EMF;
    if (embedsEmf) {
      dropped++;
      continue;
    }
    kept.push(record);
    largest = Math.max(largest, size / 2);
  }
  if (dropped === 0) return null;
  const header = Buffer.from(wmf.subarray(start, start + 18));
  const body = Buffer.concat(kept);
  header.writeUInt32LE((18 + body.length) / 2, 6); // Size, in 16-bit words
  header.writeUInt32LE(largest, 12); // MaxRecord, in 16-bit words
  return Buffer.concat([wmf.subarray(0, start), header, body]);
}

/**
 * Does this EMF or WMF carry nothing LibreOffice would hand to ANOTHER import
 * filter? A metafile passes the picture check on its magic bytes, but its
 * records can carry pictures of their own, each detected by ITS bytes: an
 * EMF+ image object holds compressed bitmap bytes (an SVG among them) or a
 * whole metafile, a brush or pen can be filled with such an image, a public
 * comment can carry an EMF, EPS or WMF, and a WMF escape can carry a whole
 * EMF (which LibreOffice then draws instead of the WMF). The third review of PR #1243 put an SVG that reads a local file into
 * an EMF+ image object, behind 4 KiB of padding so the first bytes said
 * nothing but "metafile", and LibreOffice drew the local file into the PDF.
 *
 * So the records are walked, boundedly — an EMF carried in a WMF is
 * reassembled and walked too — and the picture is cut when one of them
 * carries another picture, or when the walk cannot be finished cleanly
 * (a record running past the end, a size of zero, no end-of-file record):
 * a reader that disagrees with this walk about where a record starts could
 * find a picture this walk never saw. A cut costs the picture AND the words
 * drawn in it, which is why `keptMetafile` first looks for a second drawing
 * it can keep instead.
 *
 * Not covered, stated plainly: a bitmap in an ordinary EMF/WMF bitmap record
 * (a DIB) is kept. LibreOffice decodes a DIB as pixels; one that declares
 * PNG or JPEG compression and holds an SVG drew nothing at all (26.2,
 * measured), so no format detector saw it. Real Office EMFs with EMF+ image
 * objects (a photo pasted into a chart) are "EMF+ Dual", and `keptMetafile`
 * keeps their EMF drawing instead — the photo is drawn from the EMF records
 * if they hold it, the words always.
 */
function metafileCarriesNoPicture(bytes: Buffer): boolean {
  try {
    return isEmf(bytes) ? emfIsPlain(bytes) : wmfIsPlain(bytes);
  } catch {
    return false; // Read past the end: a record lied about its size.
  }
}

function emfIsPlain(emf: Buffer): boolean {
  let at = 0;
  let sawEof = false;
  while (at < emf.length) {
    const type = emf.readUInt32LE(at);
    const size = emf.readUInt32LE(at + 4);
    if (size < 8 || size % 4 !== 0 || at + size > emf.length) return false;
    if ((at === 0) !== (type === EMR_HEADER)) return false;
    if (EMF_RECORDS_CUT.has(type)) return false;
    if (type === EMR_COMMENT && !emfCommentIsPlain(emf.subarray(at, at + size))) return false;
    if (type === EMR_EOF) sawEof = true;
    at += size;
  }
  return sawEof;
}

/** An EMR_COMMENT: private comments are opaque to every reader; the three kinds LibreOffice reads are walked. */
function emfCommentIsPlain(record: Buffer): boolean {
  const dataSize = record.readUInt32LE(8);
  if (12 + dataSize > record.length) return false;
  if (dataSize < 4) return true;
  const data = record.subarray(12, 12 + dataSize);
  const identifier = data.readUInt32LE(0);
  if (identifier === COMMENT_EMF_PLUS) return emfPlusIsPlain(data.subarray(4));
  if (identifier === COMMENT_PUBLIC) {
    return data.length >= 8 && PUBLIC_COMMENTS_KEPT.has(data.readUInt32LE(4));
  }
  return identifier !== COMMENT_EMF_SPOOL;
}

/** EMF+ records inside one comment: no image object, and no brush or pen that could be filled with one. */
function emfPlusIsPlain(records: Buffer): boolean {
  let at = 0;
  while (at < records.length) {
    if (at + 12 > records.length) return false;
    const type = records.readUInt16LE(at);
    const flags = records.readUInt16LE(at + 2);
    const size = records.readUInt32LE(at + 4);
    const dataSize = records.readUInt32LE(at + 8);
    if (size < 12 || size % 4 !== 0 || at + size > records.length || 12 + dataSize > size) {
      return false;
    }
    if (type === EMF_PLUS_OBJECT) {
      const kind = (flags >> 8) & 0x7f;
      if (kind === EMF_PLUS_OBJECT_IMAGE) return false;
      if (kind === EMF_PLUS_OBJECT_BRUSH || kind === EMF_PLUS_OBJECT_PEN) {
        // A continued object starts mid-structure: nothing here to read it by.
        if (flags & EMF_PLUS_CONTINUED) return false;
        const data = records.subarray(at + 12, at + 12 + dataSize);
        const brush = kind === EMF_PLUS_OBJECT_PEN ? penBrushOffset(data) : 0;
        if (brush < 0 || brush + 8 > data.length) return false;
        if (data.readUInt32LE(brush + 4) === EMF_PLUS_BRUSH_TEXTURE) return false;
      }
    }
    at += size;
  }
  return true;
}

/**
 * Where an EMF+ pen's brush starts in its data, or -1: after the pen's fixed
 * fields come optional ones, present by flag, two of them counted arrays and
 * two sized blocks ([MS-EMFPLUS] 2.2.2.42).
 */
function penBrushOffset(pen: Buffer): number {
  if (pen.length < 20) return -1;
  const flags = pen.readUInt32LE(8);
  let at = 20;
  const fixed: Array<[number, number]> = [
    [0x01, 24], // transform
    [0x02, 4], // start cap
    [0x04, 4], // end cap
    [0x08, 4], // join
    [0x10, 4], // miter limit
    [0x20, 4], // line style
    [0x40, 4], // dashed line cap
    [0x80, 4], // dashed line offset
  ];
  for (const [flag, bytes] of fixed) if (flags & flag) at += bytes;
  const counted = (bytesPer: number) => {
    if (at + 4 > pen.length) return false;
    at += 4 + pen.readUInt32LE(at) * bytesPer;
    return true;
  };
  if (flags & 0x100 && !counted(4)) return -1; // dashed line
  if (flags & 0x200) at += 4; // alignment
  if (flags & 0x400 && !counted(4)) return -1; // compound line
  if (flags & 0x800 && !counted(1)) return -1; // custom start cap
  if (flags & 0x1000 && !counted(1)) return -1; // custom end cap
  if (flags & ~0x1fff) return -1; // a flag this walk does not know the size of
  return at <= pen.length ? at : -1;
}

const META_EOF = 0x0000;
const META_ESCAPE = 0x0626;
const MFCOMMENT = 0x000f;
const WMF_EMBEDDED_EMF = 0x43464d57; // "WMFC"
/** Escapes that carry PostScript for a printer — or for an EPS import. */
const WMF_ESCAPES_CUT = new Set([0x0025, 0x0026, 0x1013, 0x1014, 0x1015, 0x1016, 0x11d8]);

/**
 * A WMF: no PostScript escape, and — if it carries a whole EMF, as every WMF
 * LibreOffice and Office write does (the "WMFC" comment, split over as many
 * records as it takes) — that EMF reassembled, complete, and plain itself:
 * it is what LibreOffice draws instead of the WMF records around it.
 */
function wmfIsPlain(wmf: Buffer): boolean {
  let at = startsWith(wmf, "d7cdc69a") ? 22 : 0;
  if (at + 18 > wmf.length || wmf.readUInt16LE(at + 2) !== 9) return false;
  at += 18;
  let sawEof = false;
  const embedded: Buffer[] = [];
  let embeddedSize = -1;
  while (at < wmf.length) {
    const size = wmf.readUInt32LE(at) * 2;
    const fn = wmf.readUInt16LE(at + 4);
    if (size < 6 || at + size > wmf.length) return false;
    if (fn === META_EOF) sawEof = true;
    if (fn === META_ESCAPE) {
      if (size < 10) return false;
      const escape = wmf.readUInt16LE(at + 6);
      if (WMF_ESCAPES_CUT.has(escape)) return false;
      if (escape === MFCOMMENT && size >= 14 && wmf.readUInt32LE(at + 10) === WMF_EMBEDDED_EMF) {
        // [MS-WMF] 2.3.6.1: …, EnhancedMetafileDataSize at +40, this
        // record's share of it (CurrentRecordSize at +32) from +44.
        const chunk = wmf.readUInt32LE(at + 32);
        const total = wmf.readUInt32LE(at + 40);
        if (44 + chunk > size || (embeddedSize >= 0 && total !== embeddedSize)) return false;
        embeddedSize = total;
        embedded.push(wmf.subarray(at + 44, at + 44 + chunk));
      }
    }
    at += size;
  }
  if (!sawEof) return false;
  if (embeddedSize < 0) return true;
  const emf = Buffer.concat(embedded);
  return emf.length === embeddedSize && isEmf(emf) && emfIsPlain(emf);
}

// --- RTF -----------------------------------------------------------------

/**
 * The RTF control words whose content we cut, from the word to the end of
 * the group it stands in:
 *
 * - `pict` — a picture. LibreOffice detects its format from the bytes, so an
 *   SVG hex-encoded in a `\pict` claiming `\pngblip` was drawn as SVG and
 *   read a local file under the locked profile (second review, PR #1243).
 * - `object`, `objdata` — an embedded OLE object and its data.
 * - `fldinst` — a field's instruction. INCLUDEPICTURE and INCLUDETEXT read
 *   files; the field's last result (`\fldrslt`, the text a reader saw) stays
 *   and is what LibreOffice prints without an instruction (measured). Every
 *   instruction goes, not a list of dangerous ones: an instruction can be
 *   spelled in escapes and nested groups no text match would follow.
 */
const RTF_CUT_WORDS = new Set(["pict", "object", "objdata", "fldinst"]);

const isAsciiLetter = (b: number) => (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a);
const isAsciiDigit = (b: number) => b >= 0x30 && b <= 0x39;
const isHexDigit = (b: number | undefined) =>
  b !== undefined && (isAsciiDigit(b) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46));
/** The largest parameter an RTF reader with a signed 32-bit parameter holds. */
const RTF_MAX_PARAMETER = 2 ** 31 - 1;

/**
 * Cuts every picture, object and field-instruction group (`RTF_CUT_WORDS`)
 * from an RTF file and says how many. Ordinary text is untouched; a file with
 * nothing to cut comes back as the SAME buffer.
 *
 * A cut runs from the control word (with a `\*` right before it) to the end
 * of the group it stands in, wherever in the group it stands: LibreOffice
 * switches destination on the word itself, not only at a group's start, so
 * `{\b \pict …}` is a picture too. One forward pass, tokenizing as RTF does —
 * `\'hh` escapes, control symbols, and `\binN`, whose N raw bytes may hold
 * braces that must not end a group. A group still open at the end of the file
 * is cut to the end.
 *
 * The cut is only as good as the agreement between this tokenizer and
 * LibreOffice's about where a group ends, so the two places they could
 * disagree are REFUSED rather than guessed (third review, PR #1243):
 *
 * - `\binN` that is not plainly a count of bytes that follow: negative, more
 *   than 10 digits, past 2^31−1 (LibreOffice's 32-bit parameter overflowed
 *   2^31 to 0 and drew the `\pict` this pass had skipped over as binary), or
 *   past the end of the file. And any binary run at all OUTSIDE a group being
 *   cut: whether a reader honours `\bin` in a destination it is skipping is
 *   exactly the kind of thing two readers disagree on, and what is not cut is
 *   what LibreOffice reads. Word writes pictures and objects in hex; a binary
 *   run inside a cut group is cut with it either way.
 * - `\'` not followed by two hex digits.
 *
 * @throws OfficeFileRejectedError for either.
 */
export function sanitizeRtf(rtf: Buffer): { data: Buffer; removed: number } {
  const cuts: Array<[number, number]> = [];
  let depth = 0;
  /** Depth of the group being cut, or -1; and where its cut starts. */
  let cutDepth = -1;
  let cutFrom = 0;
  let at = 0;

  while (at < rtf.length) {
    const byte = rtf[at];
    if (byte === 0x7b) {
      depth++;
      at++;
    } else if (byte === 0x7d) {
      if (depth > 0 && cutDepth === depth) {
        cuts.push([cutFrom, at]);
        cutDepth = -1;
      }
      if (depth > 0) depth--;
      at++;
    } else if (byte === 0x5c && isAsciiLetter(rtf[at + 1])) {
      const wordStart = at + 1;
      let next = wordStart;
      while (next < rtf.length && isAsciiLetter(rtf[next])) next++;
      const word = rtf.toString("latin1", wordStart, next);
      const negative = rtf[next] === 0x2d;
      if (negative) next++;
      const digitsStart = next;
      while (next < rtf.length && isAsciiDigit(rtf[next])) next++;
      const digits = next - digitsStart;
      if (rtf[next] === 0x20) next++;
      if (word === "bin") {
        // `\binN`: N raw bytes follow, braces and backslashes included.
        const count =
          digits > 10
            ? Infinity
            : Number(rtf.toString("latin1", digitsStart, digitsStart + digits));
        if (negative || count > RTF_MAX_PARAMETER || next + count > rtf.length) {
          throw unexpected("an RTF binary run does not say plainly how long it is");
        }
        if (count > 0 && cutDepth < 0) {
          throw unexpected("an RTF binary run sits outside any picture or object");
        }
        next += count;
      }
      if (cutDepth < 0 && RTF_CUT_WORDS.has(word)) {
        cutDepth = depth;
        // `{\*\fldinst …}`: take the `\*` that marks it as ignorable with it.
        cutFrom = at >= 2 && rtf[at - 2] === 0x5c && rtf[at - 1] === 0x2a ? at - 2 : at;
      }
      at = next;
    } else if (byte === 0x5c && rtf[at + 1] === 0x27) {
      if (!isHexDigit(rtf[at + 2]) || !isHexDigit(rtf[at + 3])) {
        throw unexpected("an RTF escape is not two hex digits");
      }
      at += 4; // `\'hh`
    } else if (byte === 0x5c) {
      at += 2; // a control symbol: `\{`, `\}`, `\\`, `\*`, `\~`, …
    } else at++;
  }
  if (cutDepth >= 0) cuts.push([cutFrom, rtf.length]);
  if (cuts.length === 0) return { data: rtf, removed: 0 };

  const kept: Buffer[] = [];
  let cursor = 0;
  for (const [from, to] of cuts) {
    kept.push(rtf.subarray(cursor, from));
    cursor = to;
  }
  kept.push(rtf.subarray(cursor));
  return { data: Buffer.concat(kept), removed: cuts.length };
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
  const none = { relationshipsRemoved: 0, altChunksRemoved: 0, rtfGroupsRemoved: 0 };
  // A legacy binary .doc/.ppt cannot be rewritten here: the locked profile is
  // its only layer, and it does NOT stop an embedded SVG picture from reading
  // a local file (the canary pins that gap).
  if (container === "ole2") return { data: buffer, contentHash, ...none };
  if (container === "rtf") {
    const { data, removed } = sanitizeRtf(buffer);
    return { data, contentHash, ...none, rtfGroupsRemoved: removed };
  }

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
    const { data, removed, altChunksRemoved } = sanitizeOoxmlPackage(verified);
    return { ...none, data, relationshipsRemoved: removed, altChunksRemoved, contentHash };
  } catch (err) {
    if (err instanceof OfficeFileRejectedError) throw err;
    // A corrupt central directory: not a package, and not worth a reader's time.
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `this ${ext} file is not a valid Office Open XML package`
    );
  }
}

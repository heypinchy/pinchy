/**
 * What the knowledge base checks about an Office file BEFORE a reader (exceljs,
 * mammoth, LibreOffice) touches it. Anyone who can write to a mounted share can
 * plant these files, and the reindex opens them inside the web container —
 * which has a network, and can read the OpenClaw workspaces. Three questions,
 * answered from the bytes alone:
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
 * Every element this looks for is found by its name as a parser reads it, with
 * any prefix — `ä:` and `文書:` are as much XML as `w:` (`qualifiedNameAt`) —
 * in the text a parser reads: a part it would decode as anything but UTF-8 is
 * refused (`utf8XmlText`), since in UTF-7 not even `<` is a `<` byte —
 * and what a cut leaves is held to the same rules as what came in, because
 * the text either side of a cut can join into a new element.
 *
 * **Every** external relationship goes, hyperlinks included. Sparing
 * `hyperlink` would be wrong: LibreOffice resolves an `r:link` id
 * WITHOUT checking the relationship's Type, so a hyperlink-labelled
 * relationship used as a picture link fetched exactly like an image one
 * (measured, 3 requests). The same fact is why a kept relationship's TARGET is
 * vetted by its bytes, not its type: an `r:embed` naming a "font" or an
 * "Office part" whose bytes are SVG is drawn as SVG. And every kept target
 * must be what its type promises, by a check of what it IS, never of what it
 * is not: a font must be a font — in the format, and the place, fonts are
 * read from (`isKeptFont`) — because a rule that only refused what LOOKED
 * like a document or an SVG kept a version-0x0100 WMF and an EPS, and
 * LibreOffice drew the local file the EMF inside each one reached for.
 *
 * The same is true one level down: a metafile picture (EMF, WMF) passes on
 * its magic bytes, but its records can carry a picture of their own, which
 * LibreOffice again detects by ITS bytes. So a metafile is walked record by
 * record, and every record that can carry something else — an EMF's comments
 * (its EMF+ layer among them), a WMF's escapes (an embedded EMF among them)
 * — is dropped unread. What stays is its own plain drawing, words included;
 * one whose records do not add up is cut, and its words with it.
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
 * closes every vector known to it, each pinned by a test, and
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
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";

import {
  MAX_DOCX_MARKUP_BYTES,
  verifiedZipCopy,
  PLAIN_ATTRIBUTE_NAME,
  ZipLimitError,
  type ZipLimits,
} from "../../../../plugins/pinchy-files/docx-zip-guard";

import {
  OfficeFileRejectedError,
  StagedCopyWriteError,
  isLegacyWorkbook,
  isPresentationFile,
} from "./office-formats";
import {
  assembleZip,
  deflatedPart,
  inflatePart,
  quoteName,
  rawPart,
  readZipEntries,
  zipChunks,
  type ZipEntryInfo,
  type ZipPart,
} from "./office-zip";

const MiB = 1024 * 1024;

/**
 * The largest Office file we will load to convert. Past it the file is listed
 * as unsearchable instead. 200 MiB is well beyond any document a person writes
 * (a deck full of photographs is the realistic extreme).
 *
 * The file is staged in the reader child (`stageOfficeSource`), never in the
 * server, holding at most two copies: measured in the shipped image, a 190 MB
 * deck took the child to 483 MB and the server by nothing (in the server it
 * had cost +570 MB). Where the container cannot fit
 * that beside what the server already holds, the kernel kills the child —
 * its `oom_score_adj` is the maximum — and the file is read again next run.
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
 * limit, sheets of numeric rows:
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

/**
 * Does exceljs (4.4) PARSE this entry — or at least decode it to a string?
 * Its loader walks EVERY entry: one whose name contains `xl/media/` is
 * copied as a Buffer and becomes a picture; every other one is decoded to a
 * string first and only then matched against what it knows, so even a part
 * it ignores (printer settings, an embedded object) costs a string the size
 * of the part. Its name tests are unanchored, so a `xl/media/` name that
 * also contains `.xml` or `.vml` can reach a parser all the same: those
 * count as parsed. Counting too much costs a refused oddity; counting too
 * little costs the reader its heap.
 */
function exceljsParses(name: string): boolean {
  return !/xl\/media\//.test(name) || /[.](?:xml|vml)/i.test(name);
}

/**
 * The largest single entry of a workbook at all — in practice a picture,
 * since every part exceljs parses is held to `XLSX_MAX_PART_BYTES`. exceljs
 * copies a picture into Buffers, which the reader's heap cap does not bound.
 * Measured in the shipped image under a 1 GB container limit, one picture of
 * incompressible bytes beside two rows:
 *
 *   picture     peak RSS of the reader
 *   1 MiB       110 MB
 *   17 MiB      188 MB
 *   32 MiB      270 MB
 *   64 MiB      427 MB
 *
 * 32 MiB keeps a single picture below what a sheet at the part cap costs
 * (350 MB), and many of them do not add up: seven 32 MiB pictures peaked at
 * 432 MB, fifteen of 16 MiB at 438 MB. A phone photo is a few MB; a workbook past this is refused by its size.
 */
export const XLSX_MAX_ENTRY_BYTES = 32 * MiB;

/** Workbooks: tighter, because the model exceljs builds is heavier than the XML it reads. */
const XLSX_LIMITS: ZipLimits = {
  maxDecompressedBytes: 256 * MiB,
  maxEntryBytes: XLSX_MAX_ENTRY_BYTES,
  maxParsedEntryBytes: { bytes: XLSX_MAX_PART_BYTES, parses: exceljsParses },
  ...RATIO_RULE,
};

/**
 * What mammoth (the word-count oracle) may be handed: the conversion's limits,
 * plus a ceiling on the MARKUP it parses, summed. mammoth builds a DOM at up
 * to ~300x the XML it reads — a 1.9 MB .docx with a 31 MiB document part
 * peaked at 2.9 GB, in the web process — while a picture costs it nothing, so
 * no ceiling holds a picture back. The plugin's own `extractDocxText` uses the
 * same markup ceiling; `MAX_DOCX_MARKUP_BYTES` has the measurements. Past it
 * the oracle is skipped and the conversion is recorded `unverified`. Both the guard and mammoth run in the reader child
 * (`countDocxWordsIsolated`), whose heap cap is what bounds the DOM; these
 * ceilings only turn away early what it could not read anyway.
 */
const MAMMOTH_LIMITS: ZipLimits = {
  ...OOXML_LIMITS,
  maxMarkupBytes: MAX_DOCX_MARKUP_BYTES,
};

/**
 * The largest single Office XML part the preflight reads — and therefore the
 * largest it lets through to LibreOffice. Relationship parts and the
 * content-types part are held to it too, not to a tighter cap of their own: a
 * real catalogue's 25 000 hyperlinks make a 5.1 MB relationship part, and the
 * filter that reads them is one forward pass. Each one is inflated whole
 * into the web process to be checked; the archive's total limit (500 MiB) does not
 * bound that, and a 400 MiB `document.xml` built to stay under the ratio rule
 * took the preflight to 1.3 GB RSS. A thousand-page
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
  /**
   * What the staged package unpacks to: the sum of its entries' real sizes —
   * or null for a file that is not an archive (`.doc`/`.ppt`, RTF), which
   * LibreOffice reads as it is. LibreOffice unpacks a package into scratch
   * space while LOADING it, so this, not the file's size, is what the load
   * needs from the volume: a 152 KB `.docx` measured 26.6 MB. The converter sizes its free-space check from it.
   */
  unpackedBytes: number | null;
}

/** What staging did, without the bytes: those are on disk, where the converter reads them. */
export type StagedSource = Omit<PreparedSource, "data">;

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
 * reader to "diagnose": a bomb behind 64 junk bytes is a parse failure here
 * while JSZip opens it without complaint (measured: 989 MB RSS from a 465 KB
 * file).
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
 * brackets made one load take 4 s, 400 000 two minutes — in the web process,
 * before our code sees a cell. Excel writes neither a format longer than 255 characters nor a run of unclosed brackets.
 *
 * The format is judged as exceljs's XML parser will hand it over: with its
 * character and entity references DECODED. Counting the attribute as written
 * missed `&#91;`, which is a `[` by the time exceljs sees it — 204 of them in
 * a 1 KiB attribute cost 4.4 s per 200 000 cells.
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
 * input and held to mammoth's markup ceiling on top. A refusal here only
 * leaves the conversion unverified; it never fails it. Read in the reader
 * child, never in the server (`countDocxWordsIsolated`).
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

/**
 * What each extension may actually contain. A deck is never RTF, and a legacy
 * workbook is a BIFF file in an OLE2 container and nothing else (#1373): the
 * package sanitizer below knows the links a Word or PowerPoint package can
 * carry, not a workbook's, and an HTML "Excel export" is a web page.
 */
function allowedContainers(path: string): readonly Container[] {
  if (isLegacyWorkbook(path)) return ["ole2"];
  return isPresentationFile(path) ? ["ole2", "zip"] : ["ole2", "zip", "rtf"];
}

// ---------------------------------------------------------------------------
// 3. Does it ask LibreOffice to read something it should not?
// ---------------------------------------------------------------------------

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
 * The name of the tag whose `<` is at `at`, as written: everything up to the
 * first XML whitespace, `/`, `>` or `<`. Every element name this module looks
 * for is read through here, and compared by its local name (`localName`).
 *
 * A name is NOT `[A-Za-z_][\w.-]*`: XML takes letters from every script, so
 * `<ä:altChunk xmlns:ä="…">` is an altChunk to the reader behind this scan —
 * LibreOffice 26.2 imported one that a pattern of ASCII prefixes read past.
 * The text here is UTF-8 decoded as latin1, and a multi-byte character never
 * holds one of the delimiters, so reading to a delimiter needs no decoding.
 *
 * It stops at a `<` (which no name contains) so that no character is read
 * from more than one place: a run of `<a<a<a…` costs one pass, not one per `<`.
 */
function qualifiedNameAt(xml: string, at: number): string {
  let end = at + 1;
  while (end < xml.length && !isXmlSpace(xml[end]) && !"/<>".includes(xml[end])) end++;
  return xml.slice(at + 1, end);
}

/** A qualified name without its prefix: after the last `:`, so `a:b:c` counts as `c` too. */
const localName = (qname: string) => qname.slice(qname.lastIndexOf(":") + 1);

/** Does any tag in `xml` have a local name `matches` accepts? One forward pass. */
function hasElement(xml: string, matches: (local: string, qname: string) => boolean): boolean {
  for (let at = xml.indexOf("<"); at !== -1; at = xml.indexOf("<", at + 1)) {
    const qname = qualifiedNameAt(xml, at);
    if (matches(localName(qname), qname)) return true;
  }
  return false;
}

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
 * 942-byte .docx held the web process for 2.7 s.
 */
function attributesOf(tag: string): Map<string, string> | null {
  let at = 1 + qualifiedNameAt(tag, 0).length;
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
 * The text of an XML part as every scan in this module reads it — one
 * character per byte — or null when that is not the text a parser reads.
 *
 * Reading bytes as latin1 is exact for UTF-8: `<`, `>`, `"`, `'`, `=` and
 * every ASCII letter are those bytes and nothing else, and no byte of a
 * multi-byte character is one of them. It is not exact for any encoding a
 * part may DECLARE instead, and LibreOffice decodes a part as declared. In
 * UTF-7, `<` is `+ADw-`: a document part declaring it carried
 * `+ADw-w:altChunk r:id=+ACI-rIdH+ACI-/+AD4-`, an altChunk no scan saw, and
 * LibreOffice 26.2 imported the header whose id it borrowed as HTML and drew
 * the local files that HTML named. So the scans' assumption is enforced, not
 * extended to one more encoding:
 *
 * - the bytes are valid UTF-8 (a UTF-8 byte-order mark is fine), with no NUL —
 *   which is no XML character, and what a UTF-16 or UTF-32 spelling of ASCII
 *   is full of;
 * - a declaration, if there is one, names UTF-8 (`utf8` too, as parsers take
 *   it) or no encoding at all, which XML reads as UTF-8. Nothing else, not
 *   even an ASCII subset: no Office writer we have seen declares one — Word,
 *   LibreOffice (.docx, .xlsx, .pptx) and exceljs all write `UTF-8`.
 *
 * A declaration is one only at the very start; `<?xml ` anywhere else is not
 * well-formed, and a parser stops there rather than switching encodings.
 */
function utf8XmlText(bytes: Buffer): string | null {
  if (!isUtf8(bytes) || bytes.includes(0)) return null;
  const text = bytes.toString("latin1");
  const at = text.startsWith(UTF8_BOM_AS_LATIN1) ? UTF8_BOM_AS_LATIN1.length : 0;
  if (!text.startsWith("<?xml", at) || !isXmlSpace(text[at + 5])) return text;
  const end = text.indexOf("?>", at);
  if (end < 0 || end - at > MAX_TAG_CHARS) return null;
  // Read like a start tag (`<?xml version="1.0" encoding="…">`): a pseudo-
  // attribute named twice, or not quoted, is no declaration we can read.
  const declaration = attributesOf(`${text.slice(at, end)}>`);
  const encoding = declaration?.get("encoding");
  return declaration && (encoding === undefined || /^utf-?8$/i.test(encoding)) ? text : null;
}

/** A UTF-8 byte-order mark, as the latin1 decoding here spells it. */
const UTF8_BOM_AS_LATIN1 = "\u00EF\u00BB\u00BF";

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
 * part (UTF-8 read as latin1 — `utf8XmlText` — so the round trip is
 * byte-exact). `keep` may also throw, to refuse the package.
 *
 * What the cuts leave is read again under the same rules, and refused if it
 * holds anything they would not have let through: `<Relation` + [a cut
 * relationship] + `ship …/>` joins into a relationship nobody vetted, and
 * `<!DOC` + [a cut] + `TYPE` into a DTD.
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
    const name = qualifiedNameAt(xml, at);
    if (localName(name) !== "Relationship") {
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
    // A prefixed attribute is where this scanner and the readers part ways
    // (`PLAIN_ATTRIBUTE_NAME`): xmldom hands mammoth `q:Type` as `Type`, the
    // later of two winning. No Office writer puts one
    // on a relationship, so the part is refused rather than resolved.
    if (!attributes || [...attributes.keys()].some((name) => !PLAIN_ATTRIBUTE_NAME.test(name))) {
      throw malformed();
    }
    let end = close + 1;
    if (keep(attributes)) {
      at = end;
      continue;
    }

    if (!tag.endsWith("/>")) {
      // `<Relationship …></Relationship>`: take the closing tag with it, or
      // the part would no longer be well-formed.
      while (isXmlSpace(xml[end])) end++;
      if (!xml.startsWith(`</${name}`, end)) throw malformed();
      end += name.length + 2;
      while (isXmlSpace(xml[end])) end++;
      if (xml[end] !== ">") throw malformed();
      end++;
    }
    out += xml.slice(cursor, at);
    cursor = end;
    removed++;
    at = end;
  }

  if (removed === 0) return { xml, removed: 0 };
  out += xml.slice(cursor);
  if (filterRelationships(out, keep).removed > 0) {
    throw unexpected("a relationship part spells a new relationship once another is cut");
  }
  return { xml: out, removed };
}

/**
 * Removes every relationship that is not plainly internal from a `.rels` part.
 *
 * **Every** external relationship goes, hyperlinks included. Sparing
 * `hyperlink` would be wrong: LibreOffice resolves an `r:link` id
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
 * - `font`  — an embedded font, and only where fonts live: in the
 *             relationships of Word's font table or PowerPoint's presentation
 *             part, in the format that part embeds them in (`isKeptFont`).
 */
type TargetClass = "xml" | "image" | "font";

const TRANSITIONAL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships/";
const MS_OFFICE = "http://schemas.microsoft.com/office/";

/**
 * The relationship types a converted page is RENDERED from, by the URI
 * ECMA-376 (transitional and strict) and Microsoft's extensions give them —
 * and nothing else. "Internal is fine" is the wrong rule: an internal `aFChunk` imports an embedded HTML part, and
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
 * alone is not enough: `<svg xmlns="http://schemas.microsoft.com/office/…">`
 * is in an Office namespace, and LibreOffice draws it as an SVG — which read a
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
 * `svg` (`<s:svg`, `<ä:svg`), which no detector's byte match would see but an
 * XML reader resolving namespaces would.
 *
 * EXACTLY `svg`, for a prefixed name: `<asvg:svgBlip>` is what Office 365 and
 * LibreOffice write next to every SVG picture (and every PowerPoint Icon),
 * and a looser pattern — `svg` after ANY prefix, as a prefix of the local
 * name — would refuse every such document.
 * Unprefixed, `<svg` stays a byte match, as it is for LibreOffice: `<svgx>`
 * is taken for SVG too.
 */
const SVG_BYTES = /<svg|<!DOCTYPE/i;

/** Would LibreOffice's picture detection take these first bytes for SVG — or gzip, i.e. SVGZ? */
function looksLikeSvg(head: Buffer): boolean {
  if (head[0] === 0x1f && head[1] === 0x8b) return true;
  // NULs dropped: a UTF-16 spelling must not hide the markup from this check.
  const text = head.subarray(0, 4096).toString("latin1").replace(/\0/g, "");
  return (
    SVG_BYTES.test(text) ||
    hasElement(text, (local, qname) => qname.includes(":") && local.toLowerCase() === "svg")
  );
}

/**
 * Removes every `altChunk` element from an Office XML part — the self-closing
 * form and the one with children (`<w:altChunkPr>`) — and says how many.
 * Whatever its prefix: the name is read the way a parser reads it
 * (`qualifiedNameAt`), not matched against a pattern of what prefixes look like.
 *
 * An altChunk imports the part its `r:id` names through a SECOND import filter
 * (HTML, RTF, a nested document), which reads local files the locked profile
 * does not stop. LibreOffice resolves that id without
 * checking the relationship's Type, so cutting the `aFChunk` relationship is
 * not enough: an altChunk can borrow the id of a kept picture or font. So the
 * element goes. Everything around it stays searchable; the chunk's own content is not
 * indexed, and the converter logs that it was dropped.
 *
 * Linear: each element is read once from where the last one ended. A start
 * tag with no end, or an element with no closing tag, is refused — what
 * follows it is not ours to guess. What the cuts leave is vetted again by the
 * caller (`vetXmlPart`): a cut can join the text around it into a new element.
 */
function removeAltChunks(xml: string, partName: string): { xml: string; removed: number } {
  const malformed = () =>
    unexpected(`part ${quoteName(partName)} has an altChunk that is not well-formed`);
  let out = "";
  let cursor = 0;
  let removed = 0;
  let at = 0;
  while ((at = xml.indexOf("<", at)) !== -1) {
    const name = qualifiedNameAt(xml, at);
    if (localName(name) !== "altChunk") {
      at++;
      continue;
    }
    const close = tagEnd(xml, at);
    if (close < 0) throw malformed();
    let end = close + 1;
    if (xml[close - 1] !== "/") {
      // The first `</w:altChunk` that is that name exactly — `</w:altChunkPr>`
      // starts the same way. Searching only forward keeps this linear.
      const closingTag = `</${name}`;
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
    out += xml.slice(cursor, at);
    cursor = end;
    removed++;
    at = end;
  }
  return removed === 0 ? { xml, removed: 0 } : { xml: out + xml.slice(cursor), removed };
}

/** No SVG picture we keep is anywhere near this; a bigger one is not drawn. */
const MAX_SVG_BYTES = 16 * MiB;

/** The local name and namespace of an XML document's root element, or null if it has none we can read. */
function rootElement(xml: string): { name: string; namespace: string | undefined } | null {
  // Real Word files carry a UTF-8 byte-order mark (two contracts'
  // settings.xml in the corpus check did).
  let at = xml.startsWith(UTF8_BOM_AS_LATIN1) ? UTF8_BOM_AS_LATIN1.length : 0;
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
  if (xml[at] !== "<") return null;
  const qname = qualifiedNameAt(xml, at);
  const colon = qname.indexOf(":");
  // One prefix, or none: a name the namespace rules cannot resolve is not ours to resolve.
  if (colon !== qname.lastIndexOf(":") || colon === 0) return null;
  const prefix = colon < 0 ? undefined : qname.slice(0, colon);
  const local = localName(qname);
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

/**
 * WMF, as LibreOffice's picture detection takes one: placeable (the Aldus
 * header), or a plain header — type 1 (in memory) or 2 (on disk), header size
 * 9 — of ANY version. Asking for version 0x0300 as well missed 0x0100
 * (METAVERSION100), which LibreOffice draws all the same, embedded EMF and all.
 */
const isWmf = (bytes: Buffer) =>
  startsWith(bytes, "d7cdc69a") ||
  (bytes.length >= 4 &&
    (bytes.readUInt16LE(0) === 1 || bytes.readUInt16LE(0) === 2) &&
    bytes.readUInt16LE(2) === 9);

/** A Windows metafile — EMF (with or without EMF+) or WMF — by its magic number. */
const isMetafile = (bytes: Buffer) => isEmf(bytes) || isWmf(bytes);

/** EPS: the DOS-binary header (`C5 D0 D3 C6`, a WMF or TIFF preview behind it) or PostScript text. */
const isEps = (bytes: Buffer) =>
  startsWith(bytes, "c5d0d3c6") || bytes.subarray(0, 10).toString("latin1") === "%!PS-Adobe";

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
/** An HTML island inside an SVG, whatever its prefix: it can carry references of its own (`<img src>`). */
const isForeignObject = (local: string) => local.toLowerCase() === "foreignobject";

/**
 * A `data:` URL's picture is what its BYTES are, not what its media type
 * says: LibreOffice detects the format from the decoded content. A
 * `data:image/png;base64,` holding an SVG (or a gzipped one) is drawn as SVG
 * and reads a local file. So the bytes must be a raster, and not
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
  if (DTD.test(text) || /@import/i.test(text) || hasElement(text, isForeignObject)) return false;
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

// --- Fonts ----------------------------------------------------------------

/**
 * The format a font owner's fonts are in. Word's font table holds TrueType
 * or OpenType, its first 32 bytes obfuscated with the key the table names
 * (ECMA-376 §17.8.1) — or not obfuscated at all. PowerPoint embeds Embedded
 * OpenType (`.fntdata`), and so does LibreOffice writing a .pptx.
 */
type FontFormat = "obfuscated" | "eot";

/**
 * Where a font relationship may stand: in the relationships of a part whose
 * root is Word's font table (`w:fonts`, embedding fonts with
 * `w:embedRegular` & co.) or PowerPoint's presentation part
 * (`p:presentation`, with `p:embeddedFontLst`). That is where Word,
 * PowerPoint and LibreOffice write them, and where LibreOffice reads them
 * from. Anywhere else a font is never read as a font — only named as a
 * PICTURE (`r:embed` resolves by Id, never by Type) — and is cut.
 */
const FONT_OWNERS: ReadonlyArray<{
  root: string;
  namespaces: readonly string[];
  format: FontFormat;
}> = [
  {
    root: "fonts",
    namespaces: [
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "http://purl.oclc.org/ooxml/wordprocessingml/main",
    ],
    format: "obfuscated",
  },
  {
    root: "presentation",
    namespaces: [
      "http://schemas.openxmlformats.org/presentationml/2006/main",
      "http://purl.oclc.org/ooxml/presentationml/main",
    ],
    format: "eot",
  },
];

/** The elements of a Word font table that embed a font: an `r:id`, and the `w:fontKey` it is obfuscated with. */
const FONT_EMBED_ELEMENTS = new Set([
  "embedRegular",
  "embedBold",
  "embedItalic",
  "embedBoldItalic",
]);

/** A font owner's format, and (Word) the keys its font table gives each relationship id. */
interface FontOwner {
  format: FontFormat;
  keys: ReadonlyMap<string, readonly string[]>;
}

/**
 * The font owner whose text this is, or null for a part fonts are not read
 * from. One forward pass over a font table collects its keys.
 */
function fontOwner(text: string): FontOwner | null {
  if (DTD.test(text)) return null;
  const root = rootElement(text);
  const owner = FONT_OWNERS.find(
    ({ root: name, namespaces }) =>
      root !== null &&
      root.name === name &&
      root.namespace !== undefined &&
      namespaces.includes(root.namespace)
  );
  if (!owner) return null;
  const keys = new Map<string, string[]>();
  if (owner.format === "obfuscated") {
    for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at + 1)) {
      if (!FONT_EMBED_ELEMENTS.has(localName(qualifiedNameAt(text, at)))) continue;
      const close = tagEnd(text, at);
      if (close < 0) break;
      const attributes = attributesOf(text.slice(at, close + 1));
      if (!attributes) continue;
      let id: string | undefined;
      let fontKey: string | undefined;
      for (const [name, value] of attributes) {
        if (localName(name) === "id") id = value;
        if (localName(name) === "fontKey") fontKey = value;
      }
      if (id !== undefined && fontKey !== undefined) {
        keys.set(id, [...(keys.get(id) ?? []), fontKey]);
      }
    }
  }
  return { format: owner.format, keys };
}

/** An sfnt by its version tag: TrueType (`00 01 00 00`, `true`), OpenType with CFF (`OTTO`), a collection (`ttcf`). */
const isSfnt = (bytes: Buffer) =>
  ["00010000", "4f54544f", "74727565", "74746366"].some((tag) => startsWith(bytes, tag));

/** A `w:fontKey`: a GUID in braces, the one spelling Word and LibreOffice write and read. */
const FONT_KEY =
  /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;

/**
 * An obfuscated font's first 32 bytes as a reader de-obfuscates them
 * (ECMA-376 Part 1, §17.8.1): XORed with the key's 16 bytes, last first,
 * twice over — exactly what LibreOffice does.
 */
function deobfuscatedHead(head: Buffer, fontKey: string): Buffer {
  const key = Buffer.from(fontKey.replace(/[{}-]/g, ""), "hex").reverse();
  const out = Buffer.from(head.subarray(0, 32));
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % 16];
  return out;
}

const EOT_VERSIONS = new Set([0x00010000, 0x00020001, 0x00020002]);
const EOT_MAGIC = 0x504c; // "LP"
const EOT_COMPRESSED = 0x00000004; // TTEMBED_TTCOMPRESSED: MicroType Express
const EOT_XOR = 0x10000000; // TTEMBED_XORENCRYPTDATA: the font data XORed with 0x50
/** The fixed fields of every EOT version's header, before its strings. */
const EOT_MIN_HEADER = 82;
/** MicroType Express data opens with its version: 3 for MTX 1.0 (W3C MTX submission, §2.1). */
const MTX_VERSION = 3;

/**
 * Is this an Embedded OpenType font, as PowerPoint and LibreOffice write one
 * into a .pptx (W3C EOT submission)? The header states its own length — the
 * part's — and the length of the font data that ends it; a known version;
 * `LP` at 34. The font data is then an sfnt (XORed with 0x50 when the flags
 * say so), or MicroType Express — PowerPoint compresses — whose first byte is
 * its version. Compressed data is not inflated here.
 */
function isEot(archive: Buffer, entry: ZipEntryInfo, head: Buffer): boolean {
  if (head.length < EOT_MIN_HEADER) return false;
  const length = head.readUInt32LE(0);
  const dataLength = head.readUInt32LE(4);
  const flags = head.readUInt32LE(12);
  if (
    length !== entry.uncompressedSize ||
    !EOT_VERSIONS.has(head.readUInt32LE(8)) ||
    head.readUInt16LE(34) !== EOT_MAGIC ||
    dataLength < 4 ||
    dataLength > length - EOT_MIN_HEADER
  ) {
    return false;
  }
  const dataAt = length - dataLength;
  const data = Buffer.from(
    inflatePart(archive, entry, dataAt + 4, { partial: true }).subarray(dataAt, dataAt + 4)
  );
  if (data.length < 4) return false;
  if (flags & EOT_XOR) for (let i = 0; i < data.length; i++) data[i] ^= 0x50;
  return flags & EOT_COMPRESSED ? data[0] === MTX_VERSION : isSfnt(data);
}

/**
 * Would LibreOffice draw these bytes as a picture that can reach outside the
 * file — an SVG or SVGZ, a metafile (an EMF+ image, an EMF inside a WMF), an
 * EPS (and the WMF it previews with)? A font's STORED bytes are what a picture
 * reference to it draws, and they are not always the bytes it is judged a
 * font by: an obfuscated font's first 32 are scrambled by a key the planter
 * chooses, an EOT's first four are its length. Either can spell a picture's
 * magic number, and PowerPoint's presentation part does draw a font
 * relationship as a picture — a bullet (`a:buBlip`) in its default text
 * style, measured in LibreOffice 26.2 and 7.4.7.
 */
const drawnAsPicture = (head: Buffer) => looksLikeSvg(head) || isMetafile(head) || isEps(head);

/**
 * Is the target of font relationship `relId` a font, in a place fonts are
 * read from? Only when its relationships belong to a font owner
 * (`FONT_OWNERS`), and its bytes are a font in that owner's format: for Word,
 * an sfnt as stored or once a key the font table gives this id de-obfuscates
 * it; for PowerPoint, an EOT. Never when its stored bytes are a picture.
 */
function isKeptFont(
  archive: Buffer,
  entry: ZipEntryInfo,
  owner: FontOwner | null,
  relId: string
): boolean {
  if (!owner) return false;
  const head = inflateHead(archive, entry);
  if (drawnAsPicture(head)) return false;
  if (owner.format === "eot") return isEot(archive, entry, head);
  if (head.length < 32) return false;
  return (
    isSfnt(head) ||
    (owner.keys.get(relId) ?? []).some(
      (key) => FONT_KEY.test(key) && isSfnt(deobfuscatedHead(head, key))
    )
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
  const { parts, removed, altChunksRemoved } = sanitizedParts(buffer);
  return { data: parts ? assembleZip(parts) : buffer, removed, altChunksRemoved };
}

/**
 * `sanitizeOoxmlPackage`, stopping short of assembling the archive: the parts
 * of the rewrite — each untouched entry's bytes still INSIDE `buffer` — or
 * null when nothing needed rewriting. A caller that writes the rewrite to disk
 * writes these one after another (`zipChunks`) instead of building a second
 * copy of the package first.
 */
function sanitizedParts(buffer: Buffer): {
  parts: ZipPart[] | null;
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
  if (contentTypes) {
    const text = utf8XmlText(inflatePart(buffer, contentTypes, MAX_XML_PART_BYTES));
    if (text === null) throw unexpected("the content-types part is not UTF-8 text");
    if (DTD.test(text)) throw unexpected("the content-types part declares a DOCTYPE");
  }

  /** An Office XML part, or a refusal; any altChunk in it is cut. */
  const vetXmlPart = (entry: ZipEntryInfo): true => {
    if (entry.uncompressedSize > MAX_XML_PART_BYTES) {
      throw new OfficeFileRejectedError(
        "too_large",
        `part ${quoteName(entry.name)} is ${entry.uncompressedSize} bytes, past the ${MAX_XML_PART_BYTES}-byte limit for one part`
      );
    }
    const notOoxml = (what: string) =>
      unexpected(`part ${quoteName(entry.name)} should be Office XML but ${what}`);
    const source = utf8XmlText(inflatePart(buffer, entry, MAX_XML_PART_BYTES));
    if (source === null) throw notOoxml("is not UTF-8 text");
    /** Every check on the part's text, then its altChunks cut. */
    const vetted = (text: string) => {
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
      if (looksLikeSvg(Buffer.from(text.slice(0, 4096), "latin1"))) {
        throw notOoxml("would be drawn as an SVG picture");
      }
      return removeAltChunks(text, entry.name);
    };
    const result = vetted(source);
    if (result.removed > 0) {
      // What the cuts leave is what LibreOffice reads, so it is held to the
      // same rules: `<w:alt` + [a cut altChunk] + `Chunk r:id=…/>` joins into
      // an altChunk (LibreOffice 26.2 imported one from a staged copy), and
      // `<!DOC` + [a cut] + `TYPE` into a DTD.
      if (vetted(result.xml).removed > 0) {
        throw unexpected(`part ${quoteName(entry.name)} spells a new altChunk once another is cut`);
      }
      altChunksRemoved += result.removed;
      rewritten.set(entry, Buffer.from(result.xml, "latin1"));
    }
    return true;
  };

  /** Is the part at `name` what `kind` promises? Throws to refuse; false to cut. Memoised. */
  const vet = (name: string, kind: Exclude<TargetClass, "font">): boolean => {
    const key = `${kind}:${name.toLowerCase()}`;
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    const entry = byName.get(name.toLowerCase());
    let verdict: boolean;
    if (!entry) verdict = false;
    else if (kind === "xml") verdict = vetXmlPart(entry);
    else {
      const kept = vetImagePart(buffer, entry);
      verdict = kept !== null;
      // A metafile kept without the layer that reached for a picture.
      if (kept instanceof Buffer) rewritten.set(entry, kept);
    }
    verdicts.set(key, verdict);
    return verdict;
  };

  /** The font owner a relationship part belongs to (`fontOwner`), or null. */
  const fontOwnerOf = (relsName: string): FontOwner | null => {
    const owner = /^(.*?)_rels\/([^/]+)\.rels$/i.exec(relsName);
    const entry = owner && byName.get(`${owner[1]}${owner[2]}`.toLowerCase());
    if (!entry || entry.uncompressedSize > MAX_XML_PART_BYTES) return null;
    const text = utf8XmlText(inflatePart(buffer, entry, MAX_XML_PART_BYTES));
    return text === null ? null : fontOwner(text);
  };

  let removed = 0;

  for (const entry of entries) {
    if (!/\.rels$/i.test(entry.name)) continue;
    const text = utf8XmlText(inflatePart(buffer, entry, MAX_XML_PART_BYTES));
    if (text === null)
      throw unexpected(`relationship part ${quoteName(entry.name)} is not UTF-8 text`);

    let owner: FontOwner | null | undefined;
    const result = filterRelationships(text, (attributes) => {
      if (!isInternal(attributes)) return false;
      const kind = RENDERED_FROM.get(attributes.get("Type") ?? "");
      if (!kind) return false;
      const target = resolveTarget(entry.name, attributes.get("Target")!);
      if (target === null) return false;
      if (kind !== "font") return vet(target, kind);
      const font = byName.get(target.toLowerCase());
      if (owner === undefined) owner = fontOwnerOf(entry.name);
      return font !== undefined && isKeptFont(buffer, font, owner, attributes.get("Id") ?? "");
    });
    if (result.removed === 0) continue;
    removed += result.removed;
    rewritten.set(entry, Buffer.from(result.xml, "latin1"));
  }

  if (rewritten.size === 0) return { parts: null, removed: 0, altChunksRemoved: 0 };

  return {
    parts: entries.map((entry) => {
      const replacement = rewritten.get(entry);
      return replacement ? deflatedPart(entry.name, replacement) : rawPart(buffer, entry);
    }),
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
 * Buffer to keep THAT instead (a metafile without the records that can carry
 * something else), `null` to cut it (the picture is not drawn). Whatever would be
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
    // What a drop moved into the first kilobytes is sniffed there too.
    if (kept === null || looksLikeSvg(kept.subarray(0, 4096))) return null;
    return kept === bytes ? true : kept;
  }
  if (head[0] === 0x1f && head[1] === 0x8b) return null;
  if (entry.uncompressedSize > MAX_SVG_BYTES) return null;
  const svg = utf8XmlText(inflatePart(archive, entry, entry.uncompressedSize));
  return keepIf(svg !== null && isSelfContainedSvg(svg));
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
 * EMF records dropped besides every comment: the ones that name a file or
 * hand data to a device or another filter — colour-space and ICM-profile
 * records (a profile FILE NAME), and the escape records (PostScript and other
 * passthrough). No ordinary picture needs them to be drawn.
 */
const EMF_RECORDS_DROPPED = new Set([
  EMR_COMMENT,
  99, // EMR_CREATECOLORSPACE
  105, // EMR_DRAWESCAPE
  106, // EMR_EXTESCAPE
  110, // EMR_NAMEDESCAPE
  112, // EMR_SETICMPROFILEA
  113, // EMR_SETICMPROFILEW
  121, // EMR_COLORMATCHTOTARGETW
  122, // EMR_CREATECOLORSPACEW
]);
/** An EMR_HEADER's base fields, and its fixed fields with both optional extensions, through `szlMicrometers` ([MS-EMF] 2.3.4.2). */
const EMF_HEADER_MIN = 88;
const EMF_HEADER_FIXED = 108;

const META_EOF = 0x0000;
const META_ESCAPE = 0x0626;

/**
 * What to keep of a metafile picture: its own plain records, and nothing it
 * embeds — or null, to cut it.
 *
 * A metafile passes the picture check on its magic bytes, but some of its
 * records carry ANOTHER picture, which LibreOffice detects by its own bytes:
 * an EMF+ image object (an SVG among them), a brush or pen filled with one,
 * a public comment carrying an EMF, EPS or WMF, a WMF escape carrying a whole
 * EMF ("WMFC", which LibreOffice then draws instead of the WMF). Put an SVG
 * that reads a local file in any of them and LibreOffice draws the local file
 * into the PDF.
 *
 * So those records are not read, they are dropped — every one, whatever it
 * says it holds: every EMR_COMMENT of an EMF (the EMF+ layer, public and
 * private comments alike, `EMF_RECORDS_DROPPED`) and every META_ESCAPE of a
 * WMF. Deciding which of them LibreOffice would act on is what lost before:
 * LibreOffice reassembles a WMF's embedded EMF only from records whose
 * CommentType, Version and CommentRecordCount are Office's, and a walk that
 * took every chunk read decoys LibreOffice skips — a decoy EMF header whose
 * size swallowed the real chunk, and the EMF+ SVG in it was never walked.
 * Nothing is matched to LibreOffice's choice now; there is nothing to match.
 *
 * What stays is the metafile's own drawing — what LibreOffice draws without
 * EMF+ and without an embedded EMF, words included. Office and LibreOffice
 * write every EMF+ file "EMF+ Dual" (the EMF records draw it all again) and
 * every WMF with its embedded EMF drawn again in WMF records, so for what
 * they write nothing is lost but rendering detail. An EMF+ file that is not
 * dual keeps no drawing worth the name: the picture comes out blank, and the
 * words it drew in EMF+ are not indexed. So does the Unicode text escape
 * LibreOffice writes into a WMF for a string its font's code page cannot
 * hold: the polygons it draws instead stay, the words do not reach the index.
 *
 * Which bytes are a record is decided by this walk, so it trusts no size it
 * cannot check against another (`emfRecords`, `wmfRecords`): a reader that
 * disagreed about where a record starts could find one this walk never saw.
 * Anything that does not add up cuts the picture. The rewrite drops whole
 * records and sets the counts the header keeps (an EMF's byte and record
 * count, a WMF's size and largest record); nothing else in either format
 * points at a record's position.
 *
 * Not covered, stated plainly: a bitmap in an ordinary EMF/WMF bitmap record
 * (a DIB) is kept. LibreOffice decodes a DIB as pixels; one that declares
 * PNG or JPEG compression and holds an SVG drew nothing at all (26.2,
 * measured), so no format detector saw it.
 */
function keptMetafile(bytes: Buffer): Buffer | null {
  try {
    return isEmf(bytes) ? plainEmf(bytes) : plainWmf(bytes);
  } catch {
    return null; // Read past the end: a record lied about its size.
  }
}

/** This EMF without `EMF_RECORDS_DROPPED` (the same buffer when there are none), or null if it does not walk cleanly. */
function plainEmf(emf: Buffer): Buffer | null {
  const records = emfRecords(emf);
  if (records === null) return null;
  const kept = records.filter((record) => !EMF_RECORDS_DROPPED.has(record.readUInt32LE(0)));
  if (kept.length === records.length) return emf;
  // The header record carries nBytes at 48 and nRecords at 52.
  const out = Buffer.concat(kept);
  out.writeUInt32LE(out.length, 48);
  out.writeUInt32LE(kept.length, 52);
  return out;
}

/**
 * Every record of an EMF, or null unless they add up: the header first, of a
 * size a header has (`emfHeaderIsBounded`); every record at least 8 bytes, a
 * multiple of 4, inside the file; the end-of-file record last; and the file
 * exactly the byte count its header states.
 */
function emfRecords(emf: Buffer): Buffer[] | null {
  if (emf.length < EMF_HEADER_MIN || !emfHeaderIsBounded(emf)) return null;
  if (emf.readUInt32LE(48) !== emf.length) return null;
  const records: Buffer[] = [];
  for (let at = 0; at < emf.length;) {
    if (records.length > 0 && records[records.length - 1].readUInt32LE(0) === EMR_EOF) return null;
    const type = emf.readUInt32LE(at);
    const size = emf.readUInt32LE(at + 4);
    if (size < 8 || size % 4 !== 0 || at + size > emf.length) return null;
    if ((at === 0) !== (type === EMR_HEADER)) return null;
    records.push(emf.subarray(at, at + size));
    at += size;
  }
  const last = records[records.length - 1];
  return last.readUInt32LE(0) === EMR_EOF ? records : null;
}

/**
 * Is the EMR_HEADER no bigger than what it holds? Its fixed fields
 * (88 bytes, 108 with the optional extensions), then its description and
 * pixel format, each where its offset says — and nothing past them. A header
 * whose size claimed more swallowed whatever records it covered from this
 * walk: a decoy header that reached past an EMF+ comment hid it.
 */
function emfHeaderIsBounded(emf: Buffer): boolean {
  const size = emf.readUInt32LE(4);
  if (size < EMF_HEADER_MIN) return false;
  let end = EMF_HEADER_FIXED;
  const holds = (count: number, offset: number) => {
    if (count === 0) return true;
    if (offset < EMF_HEADER_MIN || offset + count > size) return false;
    end = Math.max(end, offset + count);
    return true;
  };
  if (!holds(emf.readUInt32LE(60) * 2, emf.readUInt32LE(64))) return false; // description, UTF-16
  if (size >= 100 && !holds(emf.readUInt32LE(88), emf.readUInt32LE(92))) return false; // pixel format
  return size <= Math.ceil(end / 4) * 4;
}

/** This WMF without its escapes (the same buffer when there are none), or null if it does not walk cleanly. */
function plainWmf(wmf: Buffer): Buffer | null {
  const start = startsWith(wmf, "d7cdc69a") ? 22 : 0;
  const records = wmfRecords(wmf, start);
  if (records === null) return null;
  const kept = records.filter((record) => record.readUInt16LE(4) !== META_ESCAPE);
  if (kept.length === records.length) return wmf;
  const header = Buffer.from(wmf.subarray(start, start + 18));
  const body = Buffer.concat(kept);
  header.writeUInt32LE((18 + body.length) / 2, 6); // Size, in 16-bit words
  const largest = kept.reduce((max, record) => Math.max(max, record.length / 2), 0);
  header.writeUInt32LE(largest, 12); // MaxRecord, in 16-bit words
  return Buffer.concat([wmf.subarray(0, start), header, body]);
}

/**
 * Every record of a WMF (after the placeable header, if any), or null unless
 * they add up: a header of 9 words, every record at least 3 words and inside
 * the file, META_EOF last — where LibreOffice stops reading — and the file
 * exactly the size its header states.
 */
function wmfRecords(wmf: Buffer, start: number): Buffer[] | null {
  if (start + 18 > wmf.length || wmf.readUInt16LE(start + 2) !== 9) return null;
  if (wmf.readUInt32LE(start + 6) * 2 !== wmf.length - start) return null;
  const records: Buffer[] = [];
  let sawEof = false;
  for (let at = start + 18; at < wmf.length;) {
    if (sawEof) return null;
    const size = wmf.readUInt32LE(at) * 2;
    if (size < 6 || at + size > wmf.length) return null;
    sawEof = size === 6 && wmf.readUInt16LE(at + 4) === META_EOF;
    records.push(wmf.subarray(at, at + size));
    at += size;
  }
  return sawEof ? records : null;
}

// --- RTF -----------------------------------------------------------------

/**
 * The RTF control words whose content we cut, from the word to the end of
 * the group it stands in:
 *
 * - `pict` — a picture. LibreOffice detects its format from the bytes, so an
 *   SVG hex-encoded in a `\pict` claiming `\pngblip` was drawn as SVG and
 *   read a local file under the locked profile.
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
 * disagree are REFUSED rather than guessed:
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
 * In-process and whole; what the converter actually uses is
 * `stageOfficeSource`, in the reader child.
 *
 * @throws OfficeFileRejectedError when the file must not be handed to a reader.
 */
export async function prepareOfficeSource(
  absPath: string,
  opts: PreflightOptions = {}
): Promise<PreparedSource> {
  const { chunks, staged } = await checkedChunks(absPath, opts);
  return { data: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks), ...staged };
}

/**
 * `prepareOfficeSource`, with the checked bytes written to `dest` (which must
 * not exist yet) instead of returned. What the converter stages through the
 * reader child (`stageOfficeSourceIsolated`): the file is read, checked and
 * written there, and the server is told only what was done.
 *
 * Holds at most two copies of the file: the original and the verified copy,
 * while the guard builds it — and the verified copy is never larger than the
 * file (`verifiedZipCopy` refuses an archive whose entries share bytes, the
 * one way a copy could outgrow it). A rewrite of the verified copy is written
 * piece by piece out of it, never assembled into a third.
 *
 * @throws OfficeFileRejectedError when the file must not be handed to a reader.
 * @throws StagedCopyWriteError when `dest` cannot be written — about the
 *   volume, not the document.
 */
export async function stageOfficeSource(
  absPath: string,
  dest: string,
  opts: PreflightOptions = {}
): Promise<StagedSource> {
  const { chunks, staged } = await checkedChunks(absPath, opts);
  try {
    // Exclusive and `0640`: in the office-converter's spool another uid
    // shares this file's group and may make entries beside it. Whatever sits
    // at this name already is refused, never written through, and a umask can
    // only remove bits — the group can read the checked copy, never write it.
    await writeFile(dest, chunks, { flag: "wx", mode: 0o640 });
  } catch (err) {
    throw new StagedCopyWriteError(err instanceof Error ? err.message : String(err));
  }
  return staged;
}

/** The checked bytes, as the pieces they are written in (see `zipChunks`), and what checking them did. */
async function checkedChunks(
  absPath: string,
  opts: PreflightOptions
): Promise<{ chunks: Buffer[]; staged: StagedSource }> {
  let buffer: Buffer | null = await readCapped(absPath, opts.maxBytes ?? OFFICE_MAX_FILE_BYTES);
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const ext = extname(absPath).toLowerCase();

  const container = sniffContainer(buffer);
  if (container === null || !allowedContainers(absPath).includes(container)) {
    throw new OfficeFileRejectedError(
      "unexpected_content",
      isLegacyWorkbook(absPath)
        ? `the content of this ${ext} file is not a legacy Excel workbook`
        : `the content of this ${ext} file is not a Word or PowerPoint document`
    );
  }
  const none = {
    contentHash,
    relationshipsRemoved: 0,
    altChunksRemoved: 0,
    rtfGroupsRemoved: 0,
    unpackedBytes: null,
  };
  // A legacy binary .doc/.ppt cannot be rewritten here: the locked profile is
  // its only layer, and it does NOT stop an embedded SVG picture from reading
  // a local file (the canary pins that gap).
  if (container === "ole2") return { chunks: [buffer], staged: none };
  if (container === "rtf") {
    const { data, removed } = sanitizeRtf(buffer);
    return { chunks: [data], staged: { ...none, rtfGroupsRemoved: removed } };
  }

  // Everything from here on reads the VERIFIED copy, and the copy (or its
  // sanitized rewrite) is what is staged: LibreOffice never sees a byte of the
  // original archive that the guard did not inflate and check.
  const verified = await verifiedCopy(buffer, OOXML_LIMITS, "Office Open XML package");
  // Nothing reads the original from here on; up to 200 MB, so it goes now.
  buffer = null;
  try {
    const entries = readZipEntries(verified);
    if (!entries.some((entry) => entry.name === "[Content_Types].xml")) {
      throw new OfficeFileRejectedError(
        "unexpected_content",
        `this ${ext} file is a zip, but not an Office Open XML package`
      );
    }
    const { parts, removed, altChunksRemoved } = sanitizedParts(verified);
    // Sizes are true here: `verified` holds only entries inflated against
    // their declared size, and a rewritten part declares its new length.
    const unpackedBytes = (parts ?? entries).reduce((sum, part) => sum + part.uncompressedSize, 0);
    return {
      chunks: parts ? zipChunks(parts) : [verified],
      staged: { ...none, relationshipsRemoved: removed, altChunksRemoved, unpackedBytes },
    };
  } catch (err) {
    if (err instanceof OfficeFileRejectedError) throw err;
    // A corrupt central directory: not a package, and not worth a reader's time.
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `this ${ext} file is not a valid Office Open XML package`
    );
  }
}

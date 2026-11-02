// Issue #424: DOCX is a ZIP archive, and mammoth materialises the full
// decompressed content in memory. The 50 MB pre-extract cap on the COMPRESSED
// file does not bound that — a high-ratio zip bomb within the cap can inflate
// to multiple GB inside the OpenClaw container.
//
// Two layers. `assertZipWithinLimits` reads the archive's central directory
// (plain offset arithmetic, no decompression) and rejects the file when the
// DECLARED total uncompressed size exceeds the limit — cheap, and it stops
// every bomb that tells the truth about its size.
//
// `verifiedZipCopy` closes the gap that leaves: an archive that LIES. An entry
// can declare 1000 bytes and inflate to a gigabyte, and the readers we feed
// (mammoth and exceljs, both through JSZip) inflate the whole entry before
// they compare it with the declared size — measured at 1.43 GB RSS for one
// such workbook (release review v0.10.0). An earlier version of this comment
// called that gap acceptable because "mainstream readers treat lying archives
// as corrupt"; they do, but only after the memory is spent. So every entry is
// inflated HERE first, by zlib, with its declared size as the hard ceiling,
// and the output is thrown away as it streams. Then the reader is handed a
// fresh archive built from the verified entries alone — so it can never see a
// byte this guard did not check: not a junk prefix (JSZip shifts its offsets
// and opens one anyway), not a local entry the central directory hides, not a
// second end record.
//
// The knowledge-base ingest in packages/web SHARES this file (it reaches it
// with a relative import that climbs out of the package): exceljs, mammoth and
// LibreOffice all inflate an OOXML package whole, and an .xlsx/.pptx is the
// same archive shape as a .docx. The canonical copy lives here because a
// plugin is deployed as a self-contained directory and can import nothing
// outside itself, while web is unconstrained. That is also why this module
// must import nothing but Node built-ins — whatever else it imported would
// become a web dependency (and, resolved out of a plugin's node_modules, would
// not resolve at all).

import * as zlib from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50; // end of central directory
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
// EOCD record (22 bytes) may be followed by a comment of up to 65535 bytes.
const EOCD_SEARCH_WINDOW = 22 + 0xffff;

// Generous for any legitimate DOCX: text XML rarely decompresses past a few
// hundred MB, and embedded media (PNG/JPEG) is stored near ratio 1.
export const MAX_DOCX_DECOMPRESSED_BYTES = 500 * 1024 * 1024;

// The largest single entry mammoth is handed. mammoth inflates a part whole
// and builds a DOM from it, which costs many times the part itself; the total
// above bounds the archive, not that (third review, PR #1243). No real
// document part comes near this — a thousand-page report's is a few MB — and
// a .docx the plugin reads is at most MAX_FILE_SIZE (10 MB) on disk, so a
// picture past it cannot be stored either.
export const MAX_DOCX_ENTRY_BYTES = 32 * 1024 * 1024;

export interface DocxDeclaredSize {
  totalUncompressedBytes: number;
}

/** One central-directory record: everything needed to locate and size an entry, nothing inflated. */
export interface ZipEntryInfo {
  name: string;
  /** Compression method: 0 = stored, 8 = deflate. */
  method: number;
  /** General-purpose bit flags (bit 0 = encrypted, bit 3 = sizes follow in a data descriptor). */
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the entry's local file header from the start of the buffer. */
  localHeaderOffset: number;
}

/**
 * A well-formed archive that is past a limit (or declares a size class we
 * refuse to trust) — as opposed to a corrupt one. Callers that fall back to a
 * reader's own "cannot open this" diagnosis for corrupt files must NOT fall
 * back for this: the reader is exactly what the limit protects.
 */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

/**
 * The archive is malformed, or shaped in a way no Office writer produces —
 * as opposed to past a limit. Still a refusal: nothing that fails this guard
 * is handed to a reader, whatever the reason.
 */
export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

function invalidDocx(detail: string): Error {
  return new ZipFormatError(`Not a valid .docx archive: ${detail}`);
}

function invalidZip(detail: string): Error {
  return new ZipFormatError(`Not a valid zip archive: ${detail}`);
}

/**
 * Reads every central-directory record. Throws (via `invalid`) on structurally
 * invalid archives — fail closed: every mainstream Office writer emits a
 * standard, non-ZIP64 central directory, so anything else is not a document we
 * should inflate.
 */
interface CentralDirectory {
  entries: ZipEntryInfo[];
  eocdOffset: number;
  cdOffset: number;
  cdSize: number;
}

function readCentralDirectory(buffer: Buffer, invalid: (detail: string) => Error): ZipEntryInfo[] {
  return readDirectory(buffer, invalid).entries;
}

function readDirectory(buffer: Buffer, invalid: (detail: string) => Error): CentralDirectory {
  const searchStart = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw invalid("end-of-central-directory record not found");
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (
    totalEntries === ZIP64_MARKER_16 ||
    cdSize === ZIP64_MARKER_32 ||
    cdOffset === ZIP64_MARKER_32
  ) {
    // A limit, not corruption: the real sizes live in a field we do not read.
    throw new ZipLimitError(invalid("ZIP64 archives are not supported").message);
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw invalid("central directory lies outside the file");
  }

  const entries: ZipEntryInfo[] = [];
  let pos = cdOffset;
  for (let entry = 0; entry < totalEntries; entry++) {
    if (pos + 46 > eocdOffset || buffer.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw invalid("malformed central directory entry");
    }
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    if (pos + 46 + nameLength + extraLength + commentLength > eocdOffset) {
      throw invalid("malformed central directory entry");
    }
    entries.push({
      name: buffer.toString("utf8", pos + 46, pos + 46 + nameLength),
      flags: buffer.readUInt16LE(pos + 8),
      method: buffer.readUInt16LE(pos + 10),
      crc32: buffer.readUInt32LE(pos + 16),
      compressedSize: buffer.readUInt32LE(pos + 20),
      // 0xFFFFFFFF defers the real size to a ZIP64 extra field. Rather than
      // trusting that field, the marker value itself (~4.3 GB) is what gets
      // summed, so the entry trips the limit check — fail closed.
      uncompressedSize: buffer.readUInt32LE(pos + 24),
      localHeaderOffset: buffer.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, eocdOffset, cdOffset, cdSize };
}

function sumDeclared(entries: ZipEntryInfo[]): number {
  return entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
}

/**
 * Sum the declared uncompressed sizes of all entries in the archive's
 * central directory. Throws on structurally invalid archives (fail closed —
 * every mainstream DOCX writer emits a standard, non-ZIP64 central
 * directory, so anything else is not a document we should inflate).
 */
export function readDeclaredDocxSize(buffer: Buffer): DocxDeclaredSize {
  return { totalUncompressedBytes: sumDeclared(readCentralDirectory(buffer, invalidDocx)) };
}

/** The archive's central-directory records, without inflating anything. Throws on an invalid archive. */
export function readZipEntries(buffer: Buffer): ZipEntryInfo[] {
  return readCentralDirectory(buffer, invalidZip);
}

export function assertDocxDecompressedSizeWithinLimit(
  buffer: Buffer,
  limit: number = MAX_DOCX_DECOMPRESSED_BYTES
): void {
  const { totalUncompressedBytes } = readDeclaredDocxSize(buffer);
  if (totalUncompressedBytes > limit) {
    throw new Error(
      `DOCX declared decompressed size (${totalUncompressedBytes} bytes) exceeds the limit (${limit} bytes). The file may be a decompression bomb.`
    );
  }
}

export interface ZipLimits {
  /** Ceiling on the sum of the entries' declared uncompressed sizes. */
  maxDecompressedBytes: number;
  /**
   * Ceiling on declared-uncompressed / file size. Only consulted once the
   * declared total passes `ratioFloorBytes`: a small, highly repetitive sheet
   * legitimately deflates a thousand to one and is no threat, while the same
   * ratio at hundreds of megabytes is a bomb that a size ceiling alone waves
   * through whenever the bomb is built to stay under it.
   */
  maxCompressionRatio?: number;
  ratioFloorBytes?: number;
  /**
   * Ceiling on any ONE entry's uncompressed size. A reader that builds a model
   * from a part (mammoth's DOM) pays for the largest part, not for the total;
   * this is where that cost is bounded. Real sizes are checked against the
   * declared ones by `verifiedZipCopy`, so the declared size is the real one.
   */
  maxEntryBytes?: number;
}

/**
 * Rejects a package that would inflate past `limits`, judged from the central
 * directory alone — nothing is decompressed. Format-agnostic, so it fronts
 * .xlsx, .docx and .pptx alike.
 */
export function assertZipWithinLimits(buffer: Buffer, limits: ZipLimits): void {
  assertDeclaredWithinLimits(buffer, readCentralDirectory(buffer, invalidZip), limits);
}

function assertDeclaredWithinLimits(buffer: Buffer, entries: ZipEntryInfo[], limits: ZipLimits) {
  if (limits.maxEntryBytes !== undefined) {
    const oversized = entries.find((entry) => entry.uncompressedSize > limits.maxEntryBytes!);
    if (oversized) {
      throw new ZipLimitError(
        `Archive entry "${oversized.name}" declares ${oversized.uncompressedSize} bytes, past the ${limits.maxEntryBytes}-byte limit for one entry.`
      );
    }
  }
  const total = sumDeclared(entries);
  if (total > limits.maxDecompressedBytes) {
    throw new ZipLimitError(
      `Archive declared decompressed size (${total} bytes) exceeds the limit (${limits.maxDecompressedBytes} bytes). The file may be a decompression bomb.`
    );
  }
  if (
    limits.maxCompressionRatio !== undefined &&
    total > (limits.ratioFloorBytes ?? 0) &&
    total / Math.max(buffer.length, 1) > limits.maxCompressionRatio
  ) {
    throw new ZipLimitError(
      `Archive compression ratio (${Math.round(total / Math.max(buffer.length, 1))}:1) exceeds the limit (${limits.maxCompressionRatio}:1). The file may be a decompression bomb.`
    );
  }
}

// ---------------------------------------------------------------------------
// Real sizes: inflate, verify, and copy only what held up
// ---------------------------------------------------------------------------

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8_NAMES = 0x0800;
/** 1980-01-01, the DOS-date epoch: a rewritten archive carries no timestamps worth keeping. */
const DOS_DATE_EPOCH = 0x0021;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** One entry of an archive being written: its bytes exactly as stored, and the sizes that describe them. */
export interface ZipPart {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  flags: number;
  crc32: number;
  uncompressedSize: number;
  /** The entry's bytes exactly as stored in the archive (compressed, for method 8). */
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE) as zip stores it, continuing from `previous`. Native when the
 * runtime has it (`zlib.crc32`, Node >= 22.2); `engines` admits 22.0, so the
 * table walk stays as the fallback.
 */
export function crc32(data: Buffer, previous = 0): number {
  const native = (zlib as { crc32?: (data: Buffer, value?: number) => number }).crc32;
  if (typeof native === "function") return native(data, previous) >>> 0;
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The entry's stored bytes, located through its LOCAL header (whose name and
 * extra lengths may differ from the central record's), bounded by `end`.
 */
export function locateEntryData(
  archive: Buffer,
  entry: ZipEntryInfo,
  end = archive.length
): Buffer {
  const at = entry.localHeaderOffset;
  if (at + 30 > end || archive.readUInt32LE(at) !== LOCAL_HEADER_SIGNATURE) {
    throw invalidZip(`entry "${entry.name}" has no local header where the directory says`);
  }
  const start = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
  const stop = start + entry.compressedSize;
  if (stop > end) throw invalidZip(`entry "${entry.name}" runs past its archive`);
  return archive.subarray(start, stop);
}

/**
 * Inflates `data` and checks it is exactly `entry.uncompressedSize` bytes with
 * the entry's CRC, without ever holding more than one chunk of the output:
 * zlib streams it, we count and checksum it, and stop the moment it runs past
 * the declared size.
 */
function verifyDeflated(entry: ZipEntryInfo, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const inflater = zlib.createInflateRaw({ chunkSize: 64 * 1024 });
    let produced = 0;
    let crc = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      reject(err);
    };
    inflater.on("data", (chunk: Buffer) => {
      produced += chunk.length;
      if (produced > entry.uncompressedSize) {
        fail(
          new ZipLimitError(
            `Archive entry "${entry.name}" inflates past the ${entry.uncompressedSize} bytes it declares. The file may be a decompression bomb.`
          )
        );
        return;
      }
      crc = crc32(chunk, crc);
    });
    inflater.on("error", () => fail(invalidZip(`entry "${entry.name}" does not inflate`)));
    inflater.on("end", () => {
      if (settled) return;
      if (produced !== entry.uncompressedSize) {
        fail(invalidZip(`entry "${entry.name}" inflates to less than it declares`));
      } else if (crc !== entry.crc32) {
        fail(invalidZip(`entry "${entry.name}" does not match its checksum`));
      } else {
        settled = true;
        resolve();
      }
    });
    inflater.end(data);
  });
}

/**
 * Checks an archive by its REAL contents and returns a fresh copy built only
 * from the entries that held up. Callers hand the COPY to their reader.
 *
 * Refuses (throws, never returns the input) when:
 *  - the declared sizes, in total or for one entry, are past `limits`
 *    (`ZipLimitError`, nothing inflated);
 *  - an entry inflates past the size it declares (`ZipLimitError`, inflation
 *    stops at the declared size);
 *  - the archive is not exactly a plain zip: bytes before its first entry or
 *    after its end record, anything between its directory and its end record
 *    but a ZIP64 end record that only repeats it, more than one disk,
 *    encryption, a method other than stored/deflate, an entry shorter than
 *    declared or with a wrong CRC, or two entries whose names differ only by
 *    case (`ZipFormatError`).
 *
 * Fail closed throughout: an archive this cannot read is not an archive any
 * reader gets to read.
 */
export async function verifiedZipCopy(buffer: Buffer, limits: ZipLimits): Promise<Buffer> {
  const { entries, eocdOffset, cdOffset, cdSize } = readDirectory(buffer, invalidZip);

  // The end record must be the archive's last bytes (its own comment
  // included), and describe one disk. Anything after it, or a second disk, is
  // somewhere a reader could look that this guard did not.
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + 22 + commentLength !== buffer.length) {
    throw invalidZip("bytes follow the end-of-central-directory record");
  }
  if (
    buffer.readUInt16LE(eocdOffset + 4) !== 0 ||
    buffer.readUInt16LE(eocdOffset + 6) !== 0 ||
    buffer.readUInt16LE(eocdOffset + 8) !== entries.length
  ) {
    throw invalidZip("multi-disk archives are not supported");
  }
  if (
    cdOffset + cdSize !== eocdOffset &&
    !isRedundantZip64End(buffer, { cdOffset, cdSize, eocdOffset, entryCount: entries.length })
  ) {
    throw invalidZip("the central directory does not end where the end record starts");
  }

  assertDeclaredWithinLimits(buffer, entries, limits);

  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw invalidZip(`two entries are both named "${entry.name}"`);
    seen.add(key);
  }

  const parts: ZipPart[] = [];
  for (const entry of entries) {
    if (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw invalidZip(`entry "${entry.name}" is encrypted`);
    }
    // Entry data must sit before the central directory, which is where every
    // writer puts it — and where the junk prefix a lenient reader forgives
    // sends these offsets wrong.
    const data = locateEntryData(buffer, entry, cdOffset);
    if (buffer.readUInt16LE(entry.localHeaderOffset + 8) !== entry.method) {
      throw invalidZip(`entry "${entry.name}" names two compression methods`);
    }
    if (entry.method === METHOD_STORED) {
      if (data.length !== entry.uncompressedSize) {
        throw invalidZip(`stored entry "${entry.name}" declares two different sizes`);
      }
      if (crc32(data) !== entry.crc32) {
        throw invalidZip(`entry "${entry.name}" does not match its checksum`);
      }
    } else if (entry.method === METHOD_DEFLATED) {
      await verifyDeflated(entry, data);
    } else {
      throw invalidZip(`entry "${entry.name}" uses an unsupported compression method`);
    }
    parts.push({
      name: entry.name,
      method: entry.method,
      flags: entry.flags,
      crc32: entry.crc32,
      uncompressedSize: entry.uncompressedSize,
      data,
    });
  }

  return assembleZip(parts);
}

const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
/** A ZIP64 end record with no extensible data: 12 fixed bytes + the 44 its size field counts. */
const ZIP64_END_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;

/**
 * Is the gap between the central directory and the classic end record exactly
 * a ZIP64 end record and its locator that say nothing the classic record does
 * not? Some writers put one there when nothing needed it — .NET's
 * System.IO.Packaging, which a lot of generated Office files come from (third
 * review, PR #1243). The classic record still carries every real value (a
 * ZIP64 marker in it is refused before this is reached), so the record is
 * accepted only when it repeats them exactly — one disk, the same entry count,
 * directory size and offset, no extensible data — and its locator points at
 * it. Anything else in that gap is somewhere a reader could look that this
 * guard did not.
 */
function isRedundantZip64End(
  buffer: Buffer,
  at: { cdOffset: number; cdSize: number; eocdOffset: number; entryCount: number }
): boolean {
  const record = at.cdOffset + at.cdSize;
  const locator = record + ZIP64_END_BYTES;
  if (locator + ZIP64_LOCATOR_BYTES !== at.eocdOffset) return false;
  const u64 = (offset: number) => buffer.readBigUInt64LE(offset);
  return (
    buffer.readUInt32LE(record) === ZIP64_END_SIGNATURE &&
    u64(record + 4) === BigInt(ZIP64_END_BYTES - 12) &&
    buffer.readUInt32LE(record + 16) === 0 &&
    buffer.readUInt32LE(record + 20) === 0 &&
    u64(record + 24) === BigInt(at.entryCount) &&
    u64(record + 32) === BigInt(at.entryCount) &&
    u64(record + 40) === BigInt(at.cdSize) &&
    u64(record + 48) === BigInt(at.cdOffset) &&
    buffer.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE &&
    buffer.readUInt32LE(locator + 4) === 0 &&
    u64(locator + 8) === BigInt(record) &&
    buffer.readUInt32LE(locator + 16) === 1
  );
}

/** Writes `parts` as a plain (non-ZIP64) archive: fresh headers, no data descriptors, entries copied as given. */
export function assembleZip(parts: readonly ZipPart[]): Buffer {
  if (parts.length >= 0xffff) throw new ZipLimitError("Archive has too many entries to write.");

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const part of parts) {
    const name = Buffer.from(part.name, "utf8");
    const ascii = name.length === part.name.length;
    // The descriptor flag is cleared: every size below is written up front.
    const flags = (part.flags & ~FLAG_DATA_DESCRIPTOR) | (ascii ? 0 : FLAG_UTF8_NAMES);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(part.method, 8);
    local.writeUInt16LE(DOS_DATE_EPOCH, 12);
    local.writeUInt32LE(part.crc32, 14);
    local.writeUInt32LE(part.data.length, 18);
    local.writeUInt32LE(part.uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(CENTRAL_DIR_SIGNATURE, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(part.method, 10);
    record.writeUInt16LE(DOS_DATE_EPOCH, 14);
    record.writeUInt32LE(part.crc32, 16);
    record.writeUInt32LE(part.data.length, 20);
    record.writeUInt32LE(part.uncompressedSize, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    name.copy(record, 46);

    chunks.push(local, part.data);
    central.push(record);
    offset += local.length + part.data.length;
    if (offset > 0xfffffffe) throw new ZipLimitError("Archive is too large to write.");
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, directory, eocd]);
}

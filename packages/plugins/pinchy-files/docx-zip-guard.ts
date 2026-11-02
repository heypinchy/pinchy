// Issue #424: DOCX is a ZIP archive, and mammoth materialises the full
// decompressed content in memory. The 50 MB pre-extract cap on the COMPRESSED
// file does not bound that — a high-ratio zip bomb within the cap can inflate
// to multiple GB inside the OpenClaw container.
//
// This guard reads the archive's central directory (plain offset arithmetic,
// no decompression, no new dependency) and rejects the file when the DECLARED
// total uncompressed size exceeds the limit. A real bomb must declare its
// sizes truthfully for ordinary readers to inflate it; a payload that lies
// about its size is caught downstream by the extracted-text cap in
// docx-extract.ts (second defense layer). Note the residual gap: that cap
// bounds what reaches the model, not mammoth's peak memory while it inflates
// a lying archive — accepted because lying archives are treated as corrupt
// by mainstream ZIP readers, so their attack value is doubtful.
//
// The knowledge-base ingest in packages/web SHARES this file (it reaches it
// with a relative import that climbs out of the package): exceljs, mammoth and
// LibreOffice all inflate an OOXML package whole, and an .xlsx/.pptx is the
// same archive shape as a .docx. The canonical copy lives here because a
// plugin is deployed as a self-contained directory and can import nothing
// outside itself, while web is unconstrained. That is also why this module
// must stay IMPORT-FREE — whatever it imported would become a web dependency
// (and, resolved out of a plugin's node_modules, would not resolve at all).

const EOCD_SIGNATURE = 0x06054b50; // end of central directory
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
// EOCD record (22 bytes) may be followed by a comment of up to 65535 bytes.
const EOCD_SEARCH_WINDOW = 22 + 0xffff;

// Generous for any legitimate DOCX: text XML rarely decompresses past a few
// hundred MB, and embedded media (PNG/JPEG) is stored near ratio 1.
export const MAX_DOCX_DECOMPRESSED_BYTES = 500 * 1024 * 1024;

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

function invalidDocx(detail: string): Error {
  return new Error(`Not a valid .docx archive: ${detail}`);
}

function invalidZip(detail: string): Error {
  return new Error(`Not a valid zip archive: ${detail}`);
}

/**
 * Reads every central-directory record. Throws (via `invalid`) on structurally
 * invalid archives — fail closed: every mainstream Office writer emits a
 * standard, non-ZIP64 central directory, so anything else is not a document we
 * should inflate.
 */
function readCentralDirectory(buffer: Buffer, invalid: (detail: string) => Error): ZipEntryInfo[] {
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
  return entries;
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
}

/**
 * Rejects a package that would inflate past `limits`, judged from the central
 * directory alone — nothing is decompressed. Format-agnostic, so it fronts
 * .xlsx, .docx and .pptx alike.
 */
export function assertZipWithinLimits(buffer: Buffer, limits: ZipLimits): void {
  const total = sumDeclared(readCentralDirectory(buffer, invalidZip));
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

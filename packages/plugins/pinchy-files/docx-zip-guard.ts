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
// docx-extract.ts (second defense layer).

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

function invalidDocx(detail: string): Error {
  return new Error(`Not a valid .docx archive: ${detail}`);
}

/**
 * Sum the declared uncompressed sizes of all entries in the archive's
 * central directory. Throws on structurally invalid archives (fail closed —
 * every mainstream DOCX writer emits a standard, non-ZIP64 central
 * directory, so anything else is not a document we should inflate).
 */
export function readDeclaredDocxSize(buffer: Buffer): DocxDeclaredSize {
  const searchStart = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw invalidDocx("end-of-central-directory record not found");
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (
    totalEntries === ZIP64_MARKER_16 ||
    cdSize === ZIP64_MARKER_32 ||
    cdOffset === ZIP64_MARKER_32
  ) {
    throw invalidDocx("ZIP64 archives are not supported");
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw invalidDocx("central directory lies outside the file");
  }

  let totalUncompressedBytes = 0;
  let pos = cdOffset;
  for (let entry = 0; entry < totalEntries; entry++) {
    if (
      pos + 46 > eocdOffset ||
      buffer.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE
    ) {
      throw invalidDocx("malformed central directory entry");
    }
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    // 0xFFFFFFFF defers the real size to a ZIP64 extra field. Rather than
    // trusting that field, count the marker value itself (~4.3 GB) so the
    // entry trips the limit check — fail closed.
    totalUncompressedBytes += uncompressedSize;

    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    pos += 46 + nameLength + extraLength + commentLength;
  }

  return { totalUncompressedBytes };
}

export function assertDocxDecompressedSizeWithinLimit(
  buffer: Buffer,
  limit: number = MAX_DOCX_DECOMPRESSED_BYTES,
): void {
  const { totalUncompressedBytes } = readDeclaredDocxSize(buffer);
  if (totalUncompressedBytes > limit) {
    throw new Error(
      `DOCX declared decompressed size (${totalUncompressedBytes} bytes) exceeds the limit (${limit} bytes). The file may be a decompression bomb.`,
    );
  }
}

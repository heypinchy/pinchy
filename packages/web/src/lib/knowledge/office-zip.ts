/**
 * Just enough zip to rewrite an OOXML package without a zip library.
 *
 * `office-preflight.ts` has to hand LibreOffice a COPY of an Office file with
 * its external relationships removed (see there for why). That needs three
 * things no dependency of ours offers cheaply: copy the untouched entries
 * WITHOUT inflating them (a 200 MB deck is mostly already-compressed media —
 * re-deflating it would cost seconds and a heap's worth of memory to change
 * nothing), inflate the few small `.rels` parts under a hard output ceiling,
 * and write a fresh archive. The central-directory READ is the shared guard in
 * `pinchy-files/docx-zip-guard.ts`, so the code that decides what a package
 * declares is the code the plugin already trusts.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { readZipEntries, type ZipEntryInfo } from "../../../../plugins/pinchy-files/docx-zip-guard";

import { OfficeFileRejectedError } from "./office-formats";

export { readZipEntries };
export type { ZipEntryInfo };

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8_NAMES = 0x0800;
/** 1980-01-01, the DOS-date epoch: the rewritten package carries no timestamps worth keeping. */
const DOS_DATE_EPOCH = 0x0021;

/** One entry of an archive being written: its compressed bytes as they will appear, and the sizes that describe them. */
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

/** CRC-32 (IEEE), as zip stores it. Hand-rolled because `zlib.crc32` only exists from Node 22.2 and `engines` admits 22.0. */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function unreadable(detail: string): OfficeFileRejectedError {
  return new OfficeFileRejectedError("unexpected_content", `Not a valid Office package: ${detail}`);
}

/** The entry's stored bytes, located through its LOCAL header (whose name/extra lengths may differ from the central record's). */
export function rawPart(archive: Buffer, entry: ZipEntryInfo): ZipPart {
  const at = entry.localHeaderOffset;
  if (at + 30 > archive.length || archive.readUInt32LE(at) !== LOCAL_HEADER_SIGNATURE) {
    throw unreadable(`entry "${entry.name}" has no local header`);
  }
  const start = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > archive.length) throw unreadable(`entry "${entry.name}" runs past the end of the file`);
  return {
    name: entry.name,
    method: entry.method,
    flags: entry.flags,
    crc32: entry.crc32,
    uncompressedSize: entry.uncompressedSize,
    data: archive.subarray(start, end),
  };
}

/** A new deflated entry carrying `content`. */
export function deflatedPart(name: string, content: Buffer): ZipPart {
  return {
    name,
    method: 8,
    flags: 0,
    crc32: crc32(content),
    uncompressedSize: content.length,
    data: deflateRawSync(content),
  };
}

/**
 * Inflates one entry, refusing to produce more than `maxBytes`. The ceiling is
 * enforced by zlib while it inflates, not checked afterwards — an entry that
 * LIES about its size in the central directory is exactly what this must
 * survive.
 */
export function inflatePart(archive: Buffer, entry: ZipEntryInfo, maxBytes: number): Buffer {
  const part = rawPart(archive, entry);
  if (part.flags & 0x0001) throw unreadable(`entry "${entry.name}" is encrypted`);
  if (part.method === 0) {
    if (part.data.length > maxBytes) throw tooLarge(entry.name);
    return Buffer.from(part.data);
  }
  if (part.method !== 8) throw unreadable(`entry "${entry.name}" uses an unsupported compression`);
  try {
    return inflateRawSync(part.data, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge(entry.name);
    throw unreadable(`entry "${entry.name}" does not inflate`);
  }
}

function tooLarge(name: string): OfficeFileRejectedError {
  return new OfficeFileRejectedError(
    "too_large",
    `entry "${name}" inflates to more than the size we are willing to read`
  );
}

/** Writes `parts` as a plain (non-ZIP64) archive: fresh headers, no data descriptors, entries copied as given. */
export function assembleZip(parts: readonly ZipPart[]): Buffer {
  if (parts.length >= 0xffff) throw tooLarge("(archive)");

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
    if (offset > 0xfffffffe) throw tooLarge("(archive)");
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

/**
 * Just enough zip to rewrite an OOXML package without a zip library.
 *
 * `office-preflight.ts` hands LibreOffice a COPY of an Office file with the
 * relationships it does not allow removed (see there for why). That needs
 * three things no dependency of ours offers cheaply: copy the untouched
 * entries WITHOUT re-deflating them (a 200 MB deck is mostly already-compressed
 * media), inflate the parts it has to read under a hard output ceiling, and
 * write a fresh archive. Reading the central directory, verifying real sizes
 * and writing an archive live in the shared guard,
 * `pinchy-files/docx-zip-guard.ts`, so the code that decides what a package
 * holds is the code the plugin already trusts; this module adds the
 * Office-specific error type and the partial reads the preflight needs.
 */
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from "node:zlib";

import {
  assembleZip,
  crc32,
  locateEntryData,
  readZipEntries,
  zipChunks,
  type ZipEntryInfo,
  type ZipPart,
} from "../../../../plugins/pinchy-files/docx-zip-guard";

import { OfficeFileRejectedError } from "./office-formats";

export { assembleZip, crc32, readZipEntries, zipChunks };
export type { ZipEntryInfo, ZipPart };

function unreadable(detail: string): OfficeFileRejectedError {
  return new OfficeFileRejectedError("unexpected_content", `Not a valid Office package: ${detail}`);
}

/** The entry's stored bytes, located through its LOCAL header (whose name/extra lengths may differ from the central record's). */
export function rawPart(archive: Buffer, entry: ZipEntryInfo): ZipPart {
  let data: Buffer;
  try {
    data = locateEntryData(archive, entry);
  } catch (err) {
    throw unreadable((err as Error).message);
  }
  return {
    name: entry.name,
    method: entry.method,
    flags: entry.flags,
    crc32: entry.crc32,
    uncompressedSize: entry.uncompressedSize,
    data,
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
export function inflatePart(
  archive: Buffer,
  entry: ZipEntryInfo,
  maxBytes: number,
  opts: { partial?: boolean } = {}
): Buffer {
  const part = rawPart(archive, entry);
  if (part.flags & 0x0001) throw unreadable(`entry "${entry.name}" is encrypted`);
  if (part.method === 0) {
    if (part.data.length > maxBytes && !opts.partial) throw tooLarge(entry.name);
    return Buffer.from(part.data.subarray(0, maxBytes));
  }
  if (part.method !== 8) throw unreadable(`entry "${entry.name}" uses an unsupported compression`);
  if (opts.partial) {
    // Just the first `maxBytes`: inflate only a slice of the stream, flushed
    // rather than finished. Deflate never shrinks below ~1:1 by more than its
    // block headers, so `maxBytes` + 1 KiB of input yields at least `maxBytes`
    // of output, and 1032:1 (deflate's ceiling) bounds what it can yield.
    const slice = part.data.subarray(0, maxBytes + 1024);
    try {
      return inflateRawSync(slice, {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: slice.length * 1032 + 1024,
      }).subarray(0, maxBytes);
    } catch {
      throw unreadable(`entry "${entry.name}" does not inflate`);
    }
  }
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

/**
 * Reads a plain-text file as the string its author wrote (#1409).
 *
 * A `.txt` in a company archive is rarely UTF-8. Windows Notepad saved
 * "ANSI" — Windows-1252 in Western Europe — for decades, and its "Unicode"
 * option meant UTF-16 with a byte-order mark. Decoded as UTF-8, either one
 * turns every umlaut into U+FFFD, and a search for the word then finds
 * nothing without any sign of why.
 *
 * The order is the one that cannot guess wrong on a file it accepts:
 *
 *   1. A byte-order mark is a statement by the writer, so it wins.
 *   2. Without one, strict UTF-8. Bytes that decode as UTF-8 almost never
 *      were meant as anything else — a Windows-1252 umlaut is a lone byte
 *      over 0x7F, which UTF-8 rejects.
 *   3. Otherwise Windows-1252, which decodes every byte. It is a superset of
 *      ISO-8859-1's printable range, so a Latin-1 file reads the same.
 *
 * UTF-16 without a BOM is not detected: there is no reliable test for it, and
 * Windows always writes the mark.
 */
import { open } from "node:fs/promises";

import { OfficeFileRejectedError } from "./office-formats";

/**
 * The same limit pinchy-files puts on a text file an agent reads
 * (`MAX_FILE_SIZE` in `packages/plugins/pinchy-files/validate.ts`): a text
 * file the agent could not open is not one the knowledge base should hold
 * either. Defined here rather than imported, because an import out of
 * `packages/web` pulls that module into the Next.js build.
 */
export const TEXT_MAX_FILE_BYTES = 10 * 1024 * 1024;

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

/** The text in `bytes`, decoded by the rule in the module comment. */
export function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, UTF8_BOM)) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export interface ReadTextOptions {
  /** Test seam; production uses `TEXT_MAX_FILE_BYTES`. */
  maxBytes?: number;
}

/**
 * The text of the file at `path`. A file over the size limit is refused with
 * `OfficeFileRejectedError("too_large")` before any of it is read — a verdict
 * on the file, final for these bytes.
 */
export async function readTextFile(path: string, opts: ReadTextOptions = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? TEXT_MAX_FILE_BYTES;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a private copy the ingest made.
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) {
      throw new OfficeFileRejectedError(
        "too_large",
        `the file is ${size} bytes, over the ${maxBytes}-byte limit for a text file`
      );
    }
    return decodeText(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/**
 * `readTextFile`: a plain-text file as the string its author wrote (#1409).
 *
 * A `.txt` in a company archive is rarely UTF-8: Windows Notepad wrote
 * Windows-1252 for decades, and "Unicode" in its save dialog meant UTF-16
 * with a byte-order mark. Read as UTF-8, either one turns every umlaut into
 * U+FFFD — a search for "Prüfbericht" then finds nothing, and nothing says
 * why. The fixtures are the bytes those editors write, built here rather than
 * checked in so the encoding is visible in the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OfficeFileRejectedError } from "@/lib/knowledge/office-formats";
import { decodeText, readTextFile } from "@/lib/knowledge/text-extract";

const SAMPLE = "Prüfbericht für Größe 3 – Maße in mm, Preis 12 €";

/** Windows-1252, the way Notepad saved "ANSI": one byte per character. */
function windows1252(text: string): Buffer {
  const special: Record<string, number> = { "€": 0x80, "–": 0x96 };
  return Buffer.from([...text].map((ch) => special[ch] ?? ch.charCodeAt(0)));
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-text-extract-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("decodeText", () => {
  it("reads UTF-8", () => {
    expect(decodeText(Buffer.from(SAMPLE, "utf8"))).toBe(SAMPLE);
  });

  it("reads UTF-8 with a byte-order mark, and drops the mark", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE, "utf8")]);
    expect(decodeText(bytes)).toBe(SAMPLE);
  });

  it("reads UTF-16 little-endian with a byte-order mark", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SAMPLE, "utf16le")]);
    expect(decodeText(bytes)).toBe(SAMPLE);
  });

  it("reads UTF-16 big-endian with a byte-order mark", () => {
    const le = Buffer.from(SAMPLE, "utf16le");
    const be = Buffer.from(le).swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(SAMPLE);
  });

  it("reads Windows-1252 when the bytes are not UTF-8, umlauts and euro sign intact", () => {
    expect(decodeText(windows1252(SAMPLE))).toBe(SAMPLE);
  });

  it("reads plain ASCII the same either way", () => {
    expect(decodeText(Buffer.from("Order 4711, qty 12"))).toBe("Order 4711, qty 12");
  });
});

describe("readTextFile", () => {
  it("reads a Windows-1252 file from disk", async () => {
    const path = join(tmpRoot, "notes.txt");
    writeFileSync(path, windows1252(SAMPLE));

    expect(await readTextFile(path)).toBe(SAMPLE);
  });

  it("refuses a file over the size limit without reading it", async () => {
    const path = join(tmpRoot, "huge.txt");
    writeFileSync(path, "x".repeat(101));

    const err = await readTextFile(path, { maxBytes: 100 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    expect((err as OfficeFileRejectedError).code).toBe("too_large");
  });
});

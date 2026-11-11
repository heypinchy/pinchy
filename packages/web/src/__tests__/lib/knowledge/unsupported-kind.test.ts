/**
 * Which of the files the indexer cannot read an admin has to act on (#1410).
 *
 * A real supplier share held hundreds of `.dll`, `.exe`, `.json` and firmware
 * files beside its documents, and every one of them was reported as "not
 * supported" — as if Pinchy had failed to read a document. Those were never
 * documents. Only a file that IS a document (a scan, an Outlook mail, a
 * legacy spreadsheet) is something the knowledge base cannot answer from yet.
 */
import { describe, it, expect } from "vitest";

import { DOCUMENT_LIKE_TYPES, unsupportedFileKind } from "@/lib/knowledge/unsupported-kind";

describe("unsupportedFileKind", () => {
  it.each([
    ".msg",
    ".eml",
    ".xlsb",
    ".rtf",
    ".jpg",
    ".png",
    ".heic",
    ".odt",
    ".zip",
    ".7z",
    ".dwg",
  ])("keeps a document-like %s as not supported yet", (type) => {
    expect(unsupportedFileKind(type)).toBe("unsupported");
  });

  it.each([".dll", ".exe", ".sys", ".ko", ".json", ".idx", ".db", ".md5", ".bin", ".ini", ".mp4"])(
    "ignores %s, which is not a document",
    (type) => {
      expect(unsupportedFileKind(type)).toBe("ignored");
    }
  );

  // Firmware images and build outputs often carry no extension, or one
  // nobody has a name for. Unknown means "not a document we know of".
  it("ignores a file without an extension and one with an unknown extension", () => {
    expect(unsupportedFileKind("")).toBe("ignored");
    expect(unsupportedFileKind(".x7q")).toBe("ignored");
  });

  it("reads the type case-insensitively", () => {
    expect(unsupportedFileKind(".MSG")).toBe("unsupported");
  });

  // A list written by an earlier version still names types the index reads
  // now (#1409 added .tif and .txt). Until the next run takes them off, they
  // are documents, not noise.
  it.each([".tif", ".tiff", ".txt", ".pdf", ".docm"])(
    "keeps %s, a type the index reads, as a document",
    (type) => {
      expect(unsupportedFileKind(type)).toBe("unsupported");
    }
  );

  it("spells every listed type as a lowercased extension with its dot", () => {
    for (const type of DOCUMENT_LIKE_TYPES) expect(type).toMatch(/^\.[a-z0-9]+$/);
  });
});

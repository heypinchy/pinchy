/**
 * Which files the indexer cannot read are documents, and which never were
 * (#1410).
 *
 * Discovery lists every file outside the extension allowlist
 * (unsupported-files.ts). On a real supplier share most of those were driver
 * DLLs, executables, JSON exports and firmware images — and the summary
 * reported every one as "not supported", as if Pinchy had failed to read a
 * document. That buried the handful of scans and Outlook mails an admin
 * actually has to act on.
 *
 * So the list is split by what a file IS, not by what we can do with it:
 *
 * - `unsupported` ("not supported yet"): a document the knowledge base cannot
 *   answer from yet — a picture or scan, a mail, a legacy or non-Microsoft
 *   office file, a drawing, an archive that probably holds documents.
 * - `ignored`: everything else — programs, data, system and media files, and
 *   any type we have no name for. Counted and listed, never warned about.
 *
 * Derived from the stored type alone, so rows recorded before the split are
 * classified the same way as new ones — no migration, no backfill.
 *
 * A type here may become readable later (#1409 .msg, #1373 .xls). That is
 * harmless: the allowlist is checked first, so a readable file never reaches
 * this list, and its entry here simply stops being consulted.
 *
 * Pure: the CSV route and the ingest both use it.
 */

import { DEFAULT_ALLOWED_EXTENSIONS } from "./exclude-globs";

export type UnsupportedFileKind = "unsupported" | "ignored";

export const DOCUMENT_LIKE_TYPES: readonly string[] = [
  // Pictures and scans
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".heic",
  ".heif",
  ".jp2",
  ".svg",
  // Mail
  ".msg",
  ".eml",
  ".emlx",
  ".oft",
  ".pst",
  ".mbox",
  // Office files we do not read, Microsoft and otherwise
  ".xls",
  ".xlsb",
  ".xlt",
  ".xltx",
  ".xltm",
  ".dot",
  ".dotx",
  ".dotm",
  ".pot",
  ".potx",
  ".potm",
  ".pptm",
  ".pps",
  ".ppsx",
  ".ppsm",
  ".vsd",
  ".vsdx",
  ".pub",
  ".one",
  ".mpp",
  ".odt",
  ".ods",
  ".odp",
  ".odg",
  ".sxw",
  ".rtf",
  ".wpd",
  ".wps",
  ".pages",
  ".numbers",
  ".key",
  // Page formats and e-books
  ".xps",
  ".oxps",
  ".ps",
  ".eps",
  ".djvu",
  ".epub",
  // Signed documents (e-invoices) and pages saved with their content
  ".p7m",
  ".mht",
  ".mhtml",
  // Text a person wrote or a page a person reads
  ".md",
  ".html",
  ".htm",
  ".csv",
  // Technical drawings
  ".dwg",
  ".dxf",
  // Archives, which on a document share usually hold documents
  ".zip",
  ".7z",
  ".rar",
  ".tar",
  ".gz",
  ".tgz",
];

// A type the index reads is a document by definition. It reaches this list
// only from a run that predates the reader (#1409 added .tif and .txt), and it
// stays a document until the next run takes it off.
const DOCUMENT_LIKE = new Set([...DOCUMENT_LIKE_TYPES, ...DEFAULT_ALLOWED_EXTENSIONS]);

/** `type` is a lowercased extension with its dot, or "" (unsupportedFileType). */
export function unsupportedFileKind(type: string): UnsupportedFileKind {
  return DOCUMENT_LIKE.has(type.toLowerCase()) ? "unsupported" : "ignored";
}

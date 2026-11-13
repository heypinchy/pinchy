/**
 * The spreadsheet reader's child process — the other half of
 * `xlsx-isolated.ts`, which forks this file with a capped heap and explains
 * why. It reads ONE request (a workbook, a range of rows, a .docx's word
 * count or text, an Outlook message, an Office file to stage for conversion,
 * or a TIFF to turn into a PDF), answers it, and exits.
 *
 * Everything that is not the read lives in the parent; this file only makes
 * itself the expendable process and relays.
 */
import { writeFileSync } from "node:fs";

import mammoth from "mammoth";

import { parseMsg } from "./msg-extract";
import { countWords, OfficeFileRejectedError, StagedCopyWriteError } from "./office-formats";
import { readGuardedDocx, stageOfficeSource } from "./office-preflight";
import { tiffToPdf } from "./tiff-pdf";
import { extractXlsx, readSheetRange, XlsxExtractionError } from "./xlsx-extract";
import type { SheetReaderFailure, SheetReaderMessage, SheetReaderRequest } from "./xlsx-isolated";

// First, before a byte of the workbook is read: if the CONTAINER runs out of
// memory (Buffers are not bounded by the heap cap), the kernel's OOM killer
// must pick this process and not the server. 1000 is the maximum, and raising
// one's own score needs no privilege. Linux only; elsewhere there is no file
// and nothing to do.
try {
  writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  // Not Linux, or /proc is not mounted — the heap cap and the timeout still hold.
}

function send(message: SheetReaderMessage): Promise<void> {
  return new Promise((resolve) => process.send!(message, () => resolve()));
}

function toFailure(err: unknown): SheetReaderFailure {
  if (err instanceof OfficeFileRejectedError) {
    return { kind: "rejected", code: err.code, message: err.message };
  }
  if (err instanceof XlsxExtractionError) {
    return { kind: "unreadable", sourcePath: err.sourcePath, reason: err.reason };
  }
  if (err instanceof StagedCopyWriteError) {
    return { kind: "staged-copy-write", message: err.message };
  }
  return { kind: "error", message: err instanceof Error ? err.message : String(err) };
}

/**
 * The text mammoth sees in a .docx or .docm — what the conversion's oracle
 * counts, and what a document whose PDF came out short is indexed from (#1406).
 * Read through the same guard the conversion input passed: mammoth inflates
 * the whole archive, so a bomb must not reach it through the oracle's door.
 */
async function docxText(path: string): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: await readGuardedDocx(path) });
  return value;
}

async function read(request: SheetReaderRequest): Promise<unknown> {
  switch (request.op) {
    case "extract":
      return extractXlsx(request.path, request.options);
    case "rows":
      return readSheetRange(request.path, request.sheet, request.startRow, request.endRow);
    case "docx-words":
      return countWords(await docxText(request.path));
    case "docx-text":
      return docxText(request.path);
    case "stage-office":
      return stageOfficeSource(request.path, request.dest);
    case "tiff-pdf":
      return tiffToPdf(request.path, request.dest, { maxFrames: request.maxFrames });
    case "msg":
      return parseMsg(request.path);
  }
}

async function answer(request: SheetReaderRequest): Promise<SheetReaderMessage> {
  try {
    return { type: "result", value: await read(request) };
  } catch (err) {
    return { type: "failure", failure: toFailure(err) };
  }
}

process.once("message", (request: SheetReaderRequest) => {
  void answer(request)
    .then(send)
    .finally(() => process.exit(0));
});

// Only now — with the readers loaded — is a death about the file it reads.
void send({ type: "ready" });

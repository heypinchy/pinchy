/**
 * The spreadsheet reader's child process — the other half of
 * `xlsx-isolated.ts`, which forks this file with a capped heap and explains
 * why. It reads ONE request, answers it, and exits.
 *
 * Everything that is not the read lives in the parent; this file only makes
 * itself the expendable process and relays.
 */
import { writeFileSync } from "node:fs";

import { OfficeFileRejectedError } from "./office-formats";
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
  return { kind: "error", message: err instanceof Error ? err.message : String(err) };
}

async function answer(request: SheetReaderRequest): Promise<SheetReaderMessage> {
  try {
    const value =
      request.op === "extract"
        ? await extractXlsx(request.path, request.options)
        : await readSheetRange(request.path, request.sheet, request.startRow, request.endRow);
    return { type: "result", value };
  } catch (err) {
    return { type: "failure", failure: toFailure(err) };
  }
}

process.once("message", (request: SheetReaderRequest) => {
  void answer(request)
    .then(send)
    .finally(() => process.exit(0));
});

// Only now — with the reader loaded — is a death about the file it reads.
void send({ type: "ready" });

// The .docx reader's child process — the other half of `docx-extract.ts`,
// which forks this file with a capped heap and explains why. It reads ONE
// request, answers it, and exits.
//
// Run by Node's own type stripping (`--experimental-strip-types`), so the
// relative import below names its `.ts` extension, and only type-only imports
// may name types.

import { writeFileSync } from "node:fs";

import { docxToMarkdown } from "./docx-markdown.ts";
import type { DocxReaderMessage, DocxReaderRequest } from "./docx-reader-protocol.ts";

// First, before a byte of the document is read: if the CONTAINER runs out of
// memory (Buffers are not bounded by the heap cap), the kernel's OOM killer
// must pick this process and not the OpenClaw gateway. 1000 is the maximum,
// and raising one's own score needs no privilege. Linux only; elsewhere there
// is no file and nothing to do.
try {
  writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  // Not Linux, or /proc is not mounted — the heap cap and the timeout still hold.
}

function send(message: DocxReaderMessage): Promise<void> {
  return new Promise((resolve) => process.send!(message, () => resolve()));
}

async function answer(request: DocxReaderRequest): Promise<DocxReaderMessage> {
  try {
    // Structured clone hands a Buffer over as a plain Uint8Array.
    const data = Buffer.from(request.data.buffer, request.data.byteOffset, request.data.byteLength);
    return { type: "result", text: await docxToMarkdown(data, request.maxTextBytes) };
  } catch (err) {
    return { type: "failure", message: err instanceof Error ? err.message : String(err) };
  }
}

process.once("message", (request: DocxReaderRequest) => {
  void answer(request)
    .then(send)
    .finally(() => process.exit(0));
});

// Only now — with mammoth and turndown loaded — is a death about the document.
void send({ type: "ready" });

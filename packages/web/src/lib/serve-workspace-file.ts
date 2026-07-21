import { NextResponse } from "next/server";
import { open } from "fs/promises";
import { extname } from "path";
import { fileTypeFromBuffer } from "file-type";
import { ALLOWED_ATTACHMENT_MIMES, ALLOWED_TEXT_MIMES } from "@/lib/upload-validation";
import { EXTENSION_TO_MIME } from "@/lib/attachment-mime";

/**
 * Read a workspace file off disk and stream it back as an inline, MIME-validated
 * response. Shared by the two agent file-serving routes — user uploads
 * (`uploads/[filename]`) and agent-delivered artifacts (`artifacts/[filename]`) —
 * which differ only in how they AUTHORIZE the request; once a caller is
 * authorized and a concrete on-disk path resolved, the serving posture is
 * identical (magic-byte MIME allowlist, inline disposition, SAMEORIGIN so the
 * PDF/image preview can embed).
 *
 * The caller MUST have already sanitized the filename and verified `fullPath`
 * is contained within the intended workspace zone — this helper does not
 * re-validate the path.
 *
 * Returns 404 if the file is missing/not a regular file, 415 if its content-type
 * is outside the upload allowlist, 200 with the bytes otherwise.
 */
export async function streamWorkspaceFile(
  fullPath: string,
  safeName: string
): Promise<NextResponse> {
  // Open FIRST, then fstat the open handle (never re-stat the path) — a
  // check-then-open on the path is a TOCTOU race (js/file-system-race). A
  // missing/permission-denied file surfaces as the open throwing → 404. The
  // handle's own stat is authoritative for the bytes we're about to read.
  let fh;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller sanitized + containment-checked the path
    fh = await open(fullPath, "r");
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  let buffer: Buffer;
  try {
    const info = await fh.stat();
    if (!info.isFile()) {
      return new NextResponse("Not found", { status: 404 });
    }
    buffer = await fh.readFile();
  } finally {
    await fh.close();
  }

  const detected = await fileTypeFromBuffer(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  );

  let servedMime: string;
  if (!detected) {
    // Text files have no magic bytes. Derive MIME from extension and verify
    // against the text allowlist. Null-byte check guards against binary files
    // renamed to .csv / .txt.
    const ext = extname(safeName).toLowerCase();
    const textMime = EXTENSION_TO_MIME[ext];
    if (!textMime || !ALLOWED_TEXT_MIMES.has(textMime) || buffer.includes(0x00)) {
      return new NextResponse("Unsupported media type", { status: 415 });
    }
    servedMime = textMime;
  } else {
    if (!ALLOWED_ATTACHMENT_MIMES.has(detected.mime)) {
      return new NextResponse("Unsupported media type", { status: 415 });
    }
    servedMime = detected.mime;
  }

  return new NextResponse(Uint8Array.from(buffer), {
    headers: {
      "content-type": servedMime,
      "content-length": String(buffer.byteLength),
      "cache-control": "private, max-age=3600",
      // Inline so the browser renders PDFs/images directly instead of forcing a
      // download. The filename is advisory.
      "content-disposition": `inline; filename="${safeName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      // Allow same-origin embeds (<embed> thumbnail in AttachmentPreview).
      // Without this override Next.js emits X-Frame-Options: DENY by default,
      // which blocks the <embed> from loading the file.
      "x-frame-options": "SAMEORIGIN",
    },
  });
}

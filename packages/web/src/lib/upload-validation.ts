import { fileTypeFromBuffer } from "file-type";

// Covers ASCII control chars, BiDi overrides, invisible Unicode, and BOM.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f​‏‪-‮⁦-⁩﻿]/u;
const MAX_FILENAME_LEN = 255;

export function sanitizeFilename(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("Invalid filename: not a string");
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new Error("Invalid filename: contains control characters");
  }
  if (raw.startsWith("./") || raw.startsWith(".\\")) {
    throw new Error("Invalid filename: absolute or relative path");
  }

  // Strip directory components, keep last segment.
  const parts = raw.replace(/\\/g, "/").split("/");

  // Reject any component that is exactly ".." (path traversal).
  for (const part of parts.slice(0, -1)) {
    if (part === "..") {
      throw new Error("Invalid filename: contains parent-directory reference");
    }
  }

  const last = parts[parts.length - 1];
  const trimmed = last.trim();

  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error("Invalid filename: empty or reserved");
  }

  if (trimmed.length > MAX_FILENAME_LEN) {
    throw new Error("Invalid filename: too long");
  }

  return trimmed;
}

export const ALLOWED_ATTACHMENT_MIMES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
]);

export async function validateUploadBuffer(buffer: Buffer, claimedMime: string): Promise<string> {
  const detected = await fileTypeFromBuffer(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  );
  if (!detected) {
    throw new Error("Unable to detect file type");
  }
  if (!ALLOWED_ATTACHMENT_MIMES.has(detected.mime)) {
    throw new Error(`File type ${detected.mime} not supported`);
  }
  if (detected.mime !== claimedMime) {
    throw new Error(`File type mismatch: claimed ${claimedMime}, content is ${detected.mime}`);
  }
  return detected.mime;
}

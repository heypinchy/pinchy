import { CLIENT_MAX_ATTACHMENT_SIZE_BYTES } from "@/lib/limits";

/**
 * Decide, client-side and BEFORE any upload, whether a picked attachment is too
 * large — returning a ready-to-toast message, or null if it's fine.
 *
 * Images are intentionally exempt: they are compressed client-side (to ~1.9 MB)
 * before upload, so their raw size never reaches the cap. Non-image files (PDF,
 * CSV, …) are sent untouched, so the raw size is what the server enforces — and
 * checking it here lets us reject instantly with a clear message instead of
 * uploading the whole file just to surface a truncated 413 on the chip.
 */
export function oversizeAttachmentError(
  file: { name: string; type: string; size: number },
  maxBytes: number = CLIENT_MAX_ATTACHMENT_SIZE_BYTES
): string | null {
  if (file.type.startsWith("image/")) return null;
  if (file.size <= maxBytes) return null;
  const limitMb = Math.round(maxBytes / 1024 / 1024);
  const fileMb = Math.round(file.size / 1024 / 1024);
  return `"${file.name}" is too large (${fileMb} MB). The maximum is ${limitMb} MB.`;
}

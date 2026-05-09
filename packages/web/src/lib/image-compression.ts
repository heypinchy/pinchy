import imageCompression from "browser-image-compression";
import {
  CLIENT_IMAGE_COMPRESSION_MAX_DIMENSION,
  CLIENT_IMAGE_COMPRESSION_QUALITY,
  CLIENT_IMAGE_COMPRESSION_SKIP_BELOW_BYTES,
  CLIENT_IMAGE_COMPRESSION_TARGET_BYTES,
} from "@/lib/limits";

/**
 * Outcome of a client-side image compression attempt.
 *
 * The discriminated union lets callers tell apart three meaningfully different
 * states that all used to return "just a File":
 *
 * - `ok: true, skipped: true`  — input was already small/format-compatible,
 *   no compression ran. Safe to send.
 * - `ok: true, skipped: false` — input was compressed successfully. Safe to send.
 * - `ok: false`                — compression failed (e.g. HEIC decode error,
 *   OOM). The original file is still attached so the caller can decide whether
 *   to send it anyway (small originals) or fail closed (originals > offload
 *   threshold, which would be silently dropped by OpenClaw).
 */
export type CompressionResult =
  | { ok: true; file: File; skipped: boolean }
  | { ok: false; file: File; reason: "compression-failed"; error: unknown };

export async function compressImageForChat(file: File): Promise<CompressionResult> {
  if (shouldSkipCompression(file)) {
    return { ok: true, file, skipped: true };
  }

  try {
    const compressed = await imageCompression(file, {
      fileType: "image/webp",
      maxSizeMB: CLIENT_IMAGE_COMPRESSION_TARGET_BYTES / (1024 * 1024),
      maxWidthOrHeight: CLIENT_IMAGE_COMPRESSION_MAX_DIMENSION,
      initialQuality: CLIENT_IMAGE_COMPRESSION_QUALITY,
      useWebWorker: true,
    });
    return { ok: true, file: compressed, skipped: false };
  } catch (err) {
    // Compression can fail on HEIC, corrupt input, OOM, or worker crashes. We
    // hand the original back so the caller can decide between sending anyway
    // (small files) and failing closed (large files that OpenClaw would offload).
    // We log so production has a paper trail when fallbacks happen — otherwise
    // a silent failure surfaces downstream as "agent ignored my image".
    console.warn("[image-compression] compression failed, falling back to original file", err);
    return { ok: false, file, reason: "compression-failed", error: err };
  }
}

function shouldSkipCompression(file: File): boolean {
  const isVisionFriendly = file.type === "image/jpeg" || file.type === "image/webp";
  return isVisionFriendly && file.size < CLIENT_IMAGE_COMPRESSION_SKIP_BELOW_BYTES;
}

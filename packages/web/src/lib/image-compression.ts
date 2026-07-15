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
    return { ok: true, file: toNamedFile(compressed, file.name), skipped: false };
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

/** Image extensions we replace with `.webp`; anything else is appended to. */
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|heic|heif)$/i;

/**
 * Rebuild the compression output as a real `File` named after the original.
 *
 * `browser-image-compression` returns a `Blob` with `name`/`lastModified`
 * monkey-patched on rather than a real `File` (its types claim otherwise, so
 * TypeScript can't catch this). Reading `.name` works, which is why the
 * composer chip looked right — but `FormData.append()` ignores the patched
 * property and labels any non-File Blob `"blob"` on the wire, so every
 * compressed image landed in the agent workspace as `blob`, `blob (1)`, ...
 */
function toNamedFile(compressed: Blob, originalName: string): File {
  const base = originalName.replace(IMAGE_EXTENSION, "");
  // Compression converts to WebP, so the original extension would now lie about
  // the bytes. Names without an image extension keep their dots and just gain one.
  return new File([compressed], `${base}.webp`, {
    type: compressed.type,
    lastModified: Date.now(),
  });
}

function shouldSkipCompression(file: File): boolean {
  const isVisionFriendly = file.type === "image/jpeg" || file.type === "image/webp";
  return isVisionFriendly && file.size < CLIENT_IMAGE_COMPRESSION_SKIP_BELOW_BYTES;
}

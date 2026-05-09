import imageCompression from "browser-image-compression";
import {
  CLIENT_IMAGE_COMPRESSION_MAX_DIMENSION,
  CLIENT_IMAGE_COMPRESSION_QUALITY,
  CLIENT_IMAGE_COMPRESSION_SKIP_BELOW_BYTES,
  CLIENT_IMAGE_COMPRESSION_TARGET_BYTES,
} from "@/lib/limits";

export async function compressImageForChat(file: File): Promise<File> {
  if (shouldSkipCompression(file)) {
    return file;
  }

  try {
    return await imageCompression(file, {
      fileType: "image/webp",
      maxSizeMB: CLIENT_IMAGE_COMPRESSION_TARGET_BYTES / (1024 * 1024),
      maxWidthOrHeight: CLIENT_IMAGE_COMPRESSION_MAX_DIMENSION,
      initialQuality: CLIENT_IMAGE_COMPRESSION_QUALITY,
      useWebWorker: true,
    });
  } catch {
    return file;
  }
}

function shouldSkipCompression(file: File): boolean {
  const isVisionFriendly = file.type === "image/jpeg" || file.type === "image/webp";
  return isVisionFriendly && file.size < CLIENT_IMAGE_COMPRESSION_SKIP_BELOW_BYTES;
}

/**
 * Maps a file's MIME type to the model capability required to process it.
 * Returns null when no specific capability check is needed (e.g. plain text).
 */
export function requiredCapabilityForFile(mimeType: string): "vision" | "documents" | null {
  if (mimeType.startsWith("image/")) return "vision";
  if (mimeType === "application/pdf") return "documents";
  return null;
}

/**
 * Extension → MIME mapping for text attachments that browsers often leave
 * untyped (empty `File.type`) or mislabel as `application/octet-stream`.
 *
 * Mirrors `ALLOWED_TEXT_MIMES` in upload-validation.ts. Shared by the upload
 * GET route (which derives the served Content-Type from the extension) and the
 * chat upload adapter (which derives the claimed MIME before encoding), so both
 * sides agree on the canonical MIME for a given extension.
 *
 * This module is intentionally dependency-free so it is safe to import into the
 * client bundle — unlike upload-validation.ts, which pulls in the Node-only
 * `file-type` package.
 */
export const EXTENSION_TO_MIME: Record<string, string> = {
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

/**
 * Return the canonical text MIME for a filename's extension, or `undefined`
 * when the extension is not a recognized text format (e.g. `.pdf`, `.png`).
 */
export function mimeFromFilename(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXTENSION_TO_MIME[lower.slice(dot)];
}

/**
 * Extension → MIME mapping for text attachments that browsers often leave
 * untyped (empty `File.type`) or mislabel as `application/octet-stream`.
 *
 * Mirrors `ALLOWED_TEXT_MIMES` in upload-validation.ts. The upload GET route
 * indexes this map to derive the served Content-Type from a file's extension.
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
 * `<input accept>` value for the chat composer's file picker. Lists both MIME
 * types and file extensions so browsers that don't infer extension→MIME
 * (Safari historically lags) still match. `image/*` covers the image
 * allowlist as a glob — narrower would block heic/heif on browsers that
 * report odd MIMEs. The drift guard in
 * `__tests__/lib/attachment-accept-attribute.test.ts` asserts every MIME in
 * `ALLOWED_ATTACHMENT_MIMES` ∪ `ALLOWED_TEXT_MIMES` is reachable through
 * this string, so server allowlist changes can't silently desync from the
 * picker.
 */
export const INPUT_ACCEPT_ATTRIBUTE = [
  // Images — covered by the glob so heic/heif don't need explicit entries.
  "image/*",
  // PDFs.
  "application/pdf",
  // Text formats — list both MIME and extension because some browsers report
  // empty File.type for these.
  "text/csv",
  ".csv",
  "text/plain",
  ".txt",
  "text/markdown",
  ".md",
  ".markdown",
  "application/json",
  ".json",
  "text/yaml",
  ".yaml",
  ".yml",
].join(",");

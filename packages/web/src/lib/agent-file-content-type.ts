/**
 * Extension -> Content-Type mapping for `GET /api/agents/[agentId]/workspace-file`.
 *
 * Deliberately extension-based, NOT magic-byte sniffing (contrast with
 * `upload-validation.ts`'s `fileTypeFromBuffer`): this route serves files an
 * admin has already granted an agent access to (`allowed_paths`), not
 * user-uploaded content, so the trust boundary is different — no need to
 * verify the bytes match a claimed type, only to pick a safe Content-Type to
 * serve them as.
 *
 * Only `application/pdf` is served `inline` (the MVP citation use case: a
 * `<embed>`/browser PDF viewer with a `#page=N` deep link). Every other type
 * — including HTML, SVG, and anything unrecognized — is served as an
 * `attachment` download. This is the anti-XSS control: an HTML or SVG file
 * sitting under an admin-configured allowed path must never be rendered
 * inline by the browser as same-origin content (stored XSS). Callers MUST
 * also set `X-Content-Type-Options: nosniff` so the browser can't override
 * this Content-Type via its own sniffing.
 */
import { extname } from "node:path";

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface ContentTypeInfo {
  contentType: string;
  /** Only "application/pdf" is ever "inline" — everything else downloads. */
  disposition: "inline" | "attachment";
}

export function contentTypeForFile(filePath: string): ContentTypeInfo {
  const ext = extname(filePath).toLowerCase();
  // eslint-disable-next-line security/detect-object-injection -- read-only lookup on a static string->string map with a safe fallback, not a prototype-pollution sink.
  const contentType = EXTENSION_CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
  return {
    contentType,
    disposition: contentType === "application/pdf" ? "inline" : "attachment",
  };
}

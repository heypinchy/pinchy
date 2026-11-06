/**
 * Which saved attachments the user will actually see in chat as a download.
 *
 * Pinchy's web side renders a chip only for a type its serving route can
 * stream — `SERVABLE_DELIVERED_MIMES` in packages/web/src/lib/serve-workspace-file.ts,
 * checked in `deliverRunArtifacts` (server/stream-pipe.ts) against the
 * `mimeType` of the file block this plugin emits. A Word document, an old
 * `.xls`, a ZIP or an unknown binary is saved to `uploads/` and gets no chip.
 * The tool result has to say the same thing, or the agent tells the user it
 * delivered a file that never appears.
 *
 * The set is a COPY: a plugin directory is mounted into the OpenClaw container
 * on its own, so it cannot import from the web package. The copy is pinned by
 * packages/web/src/__tests__/lib/email-delivery-mime-drift.test.ts. Keep this
 * module import-free so that test can load it.
 */
export const SERVABLE_DELIVERED_MIMES: ReadonlySet<string> = new Set<string>([
  // ALLOWED_ATTACHMENT_MIMES (upload-validation.ts)
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "text/vcard",
  // ALLOWED_TEXT_MIMES (upload-validation.ts)
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "text/yaml",
  "text/x-vcard",
  // DELIVERY_ONLY_BINARY_MIMES (serve-workspace-file.ts)
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/**
 * Extension → servable type. Used only when the sender's declared type is a
 * generic label (see GENERIC_LABELS); the text entries mirror the web's
 * EXTENSION_TO_MIME, which is how the serving route types a text file.
 */
export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".vcf": "text/vcard",
};

/**
 * Declared types that say little about the content. Mail clients send them for
 * files they could not type: octet-stream for anything, and
 * `application/vnd.ms-excel` for a CSV (Windows associates `.csv` with Excel).
 * Only these defer to the extension. A specific declared type is kept, because
 * the serving route sniffs the bytes: a Word document named `.pdf` would get a
 * chip that then refuses to download.
 */
const GENERIC_LABELS = new Set<string>([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  "application/x-download",
  "application/force-download",
  "application/vnd.ms-excel",
]);

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(idx).toLowerCase() : "";
}

/**
 * The type to declare for a saved attachment: the sender's type, lower-cased
 * and without parameters (`Text/CSV; charset=UTF-8` → `text/csv`), or — when
 * that type is a generic label — the type the extension names.
 */
export function deliveryMimeType(declared: string | undefined, filename: string): string {
  const normalized = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (SERVABLE_DELIVERED_MIMES.has(normalized)) return normalized;
  if (GENERIC_LABELS.has(normalized)) {
    const fromExtension = MIME_BY_EXTENSION[extensionOf(filename)];
    if (fromExtension) return fromExtension;
  }
  return normalized || "application/octet-stream";
}

/** Whether a (normalized) type will appear in chat as a download chip. */
export function isServableDelivery(mimeType: string): boolean {
  return SERVABLE_DELIVERED_MIMES.has(mimeType);
}

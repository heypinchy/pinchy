/**
 * Maps a file's MIME type to the model capability required to process it.
 * Returns null when no capability of the AGENT model is needed.
 *
 * Only images require a capability (vision): they are base64-encoded and
 * shipped as direct model input. PDFs deliberately return null — they are
 * placed in the agent workspace and read via pinchy-files' own `pinchy_read`,
 * whose PDF subsystem (pdf-extract for the text layer, pdf-vision for scanned
 * pages) needs no capability of the agent's chat model. Text formats are also
 * workspace files read via `pinchy_read`.
 */
export function requiredCapabilityForFile(mimeType: string): "vision" | null {
  if (mimeType.startsWith("image/")) return "vision";
  return null;
}

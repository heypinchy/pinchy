/**
 * Maps a file's MIME type to the model capability required to process it.
 * Returns null when no capability of the AGENT model is needed.
 *
 * Only images require a capability (vision): they are base64-encoded and
 * shipped as direct model input. PDFs deliberately return null — they are
 * placed in the agent workspace and analyzed via OpenClaw's built-in `pdf`
 * tool, whose model Pinchy resolves itself (`resolveDefaultPdfModel()`),
 * independent of the agent's chat model. Text formats are workspace files
 * read via `pinchy_read`.
 */
export function requiredCapabilityForFile(mimeType: string): "vision" | null {
  if (mimeType.startsWith("image/")) return "vision";
  return null;
}

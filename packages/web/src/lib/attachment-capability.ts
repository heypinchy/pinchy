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

/**
 * Note shown on an image attachment when the AGENT's own model can't accept
 * images directly. Deliberately NOT a flat "doesn't support image input" —
 * Pinchy offloads the image to the configured vision model
 * (`resolveImageTurnModel`/`getConfiguredImageModel`), which describes it and
 * injects the description, so a text-only agent usually still answers correctly.
 * The old wording contradicted that outcome (a text-only model returned a
 * correct description yet the chip claimed it couldn't). If no vision model is
 * configured anywhere, the send fails with the honest, admin-actionable
 * `vision_unavailable` error at send time.
 */
export const IMAGE_INPUT_OFFLOAD_NOTE =
  "This model can't read images directly — a vision model will describe it if one is configured.";

/**
 * The note (if any) to show on an attachment chip. Returns the offload note only
 * for an image whose agent model is known to lack vision; null for non-images,
 * for a vision-capable model, or while capabilities are still loading
 * (`modelVisionCapable` is `null`/`undefined`) so nothing flashes before we know.
 */
export function imageInputNote(
  mimeType: string,
  modelVisionCapable: boolean | null | undefined
): string | null {
  if (requiredCapabilityForFile(mimeType) !== "vision") return null;
  if (modelVisionCapable !== false) return null;
  return IMAGE_INPUT_OFFLOAD_NOTE;
}

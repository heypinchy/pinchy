/**
 * Shared capability types — no DB imports, safe for client components.
 *
 * Only capabilities with real consumers exist here. `documents`, `audio` and
 * `video` were removed: PDFs route via OpenClaw's `pdf` tool (the agent model
 * never receives PDF bytes), and audio/video files are not uploadable at all
 * (see ALLOWED_ATTACHMENT_MIMES, #321).
 */

export type ModelCapabilities = {
  vision: boolean;
  longContext: boolean;
  tools: boolean;
};

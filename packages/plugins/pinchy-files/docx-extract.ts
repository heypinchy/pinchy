import mammoth from "mammoth";

export interface DocxExtractionResult {
  text: string;
  /**
   * Non-fatal messages mammoth produced (e.g. unsupported elements). Surfaced
   * so callers can log or attach them to the audit detail later without
   * breaking the public API.
   */
  messages?: string[];
}

/**
 * Extract plain text from a `.docx` buffer using mammoth.
 *
 * Returns the document's paragraph, heading, and table cell text. Inline
 * formatting (bold, italics) is preserved as plain text — formatting marks
 * are not emitted because the agent doesn't need them to understand a
 * briefing.
 */
export async function extractDocxText(
  buffer: Buffer,
): Promise<DocxExtractionResult> {
  const { value, messages } = await mammoth.extractRawText({ buffer });
  return {
    text: value,
    messages: messages.length > 0 ? messages.map((m) => m.message) : undefined,
  };
}

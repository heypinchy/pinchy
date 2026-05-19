import mammoth from "mammoth";

export interface DocxExtractionResult {
  text: string;
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
  const { value } = await mammoth.extractRawText({ buffer });
  return { text: value };
}

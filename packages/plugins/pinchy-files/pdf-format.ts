import type { PdfExtractionResult } from "./pdf-extract";

export function formatPdfResult(
  result: PdfExtractionResult,
  sourcePath: string,
): string {
  const lines: string[] = [];

  lines.push("<document>");
  lines.push(`  <source>${sourcePath}</source>`);
  lines.push(`  <pages>${result.totalPages}</pages>`);

  if (result.truncated) {
    lines.push(
      `  <note>Document truncated: showing first ${result.pages.length} of ${result.totalPages} pages.</note>`,
    );
  }

  lines.push("  <document_content>");

  for (const page of result.pages) {
    if (page.text.trim()) {
      lines.push(page.text.trim());
      lines.push("");
    }

    if (page.isScanned && !page.text.trim()) {
      lines.push(
        "[Unable to extract text from this scanned page.]",
      );
      lines.push("");
    }
  }

  lines.push("  </document_content>");
  lines.push("</document>");

  return lines.join("\n");
}

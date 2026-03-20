import type { PdfExtractionResult } from "./pdf-extract";

interface FormatOptions {
  /** Whether rendered page images are included as separate content blocks */
  imagesAttached?: boolean;
}

export function formatPdfResult(
  result: PdfExtractionResult,
  sourcePath: string,
  options: FormatOptions = {},
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
      if (options.imagesAttached) {
        lines.push(
          `[Scanned page ${page.pageNumber} — see attached page image below for visual content.]`,
        );
      } else {
        lines.push(
          "[Unable to extract text from this scanned page.]",
        );
      }
      lines.push("");
    }
  }

  lines.push("  </document_content>");
  lines.push("</document>");

  return lines.join("\n");
}

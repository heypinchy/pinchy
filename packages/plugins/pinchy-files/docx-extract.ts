import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  assertDocxDecompressedSizeWithinLimit,
  MAX_DOCX_DECOMPRESSED_BYTES,
} from "./docx-zip-guard";

export interface DocxExtractionResult {
  text: string;
}

export interface DocxExtractOptions {
  /** Cap on the archive's declared decompressed size (issue #424). */
  maxDecompressedBytes?: number;
  /** Cap on the extracted Markdown length — second defense layer. */
  maxTextBytes?: number;
}

// Aligned with MAX_FILE_SIZE in validate.ts: a .docx may not hand the model
// more text than the largest plain-text file pinchy_read would serve.
export const MAX_DOCX_EXTRACTED_TEXT_BYTES = 10 * 1024 * 1024;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
// Until vision lands, embedded images contribute no usable text — the
// placeholder signals to the model that visual content was elided.
turndown.addRule("strip-image", {
  filter: "img",
  replacement: () => "[image]",
});

/**
 * Normalize mammoth-generated table HTML so turndown's GFM plugin can
 * render pipe tables.
 *
 * Mammoth emits tables as `<table><tr><td>...</td></tr></table>` — no
 * `<thead>`, no `<th>`, and cells wrapped in `<p>`. The
 * turndown-plugin-gfm table rule only activates when the first row is a
 * heading row (all-`<th>` or inside `<thead>`). We:
 *  1. Strip `<p>` wrappers inside cells so content is inline.
 *  2. Promote the first `<tr>` into a `<thead>` with `<th>` cells so the
 *     GFM rule fires and emits pipe-delimited Markdown.
 *
 * KEEP-IN-SYNC with `normalizeDocxTableHtml` in
 * `packages/web/src/hooks/use-ws-runtime.ts`. Both must apply the same
 * transformations so KB reads and composer uploads produce identical table
 * Markdown. Intentional duplication: the web file uses dynamic imports for
 * bundle isolation; a shared package would complicate that.
 */
function normalizeTableHtml(html: string): string {
  let out = html.replace(
    /<(td|th)([^>]*)><p>([\s\S]*?)<\/p><\/(td|th)>/g,
    "<$1$2>$3</$1>",
  );

  // Mammoth emits no <tbody>, so rows sit directly under <table>.
  out = out.replace(/<table>([\s\S]*?)<\/table>/g, (_, inner: string) => {
    const firstRowMatch = inner.match(/^(<tr>[\s\S]*?<\/tr>)/);
    if (!firstRowMatch) return `<table>${inner}</table>`;
    const firstRow = firstRowMatch[1];
    const rest = inner.slice(firstRow.length);
    const headingRow = firstRow
      .replace(/<td([^>]*)>/g, "<th$1>")
      .replace(/<\/td>/g, "</th>");
    return `<table><thead>${headingRow}</thead><tbody>${rest}</tbody></table>`;
  });

  return out;
}

/**
 * Extract a DOCX buffer as Markdown.
 *
 * Pipeline: mammoth → HTML → normalizeTableHtml → turndown → Markdown.
 * Mammoth's own `convertToMarkdown` is deprecated and degrades tables to one
 * paragraph per cell — the HTML route preserves table structure and
 * round-trips through turndown's GFM plugin as pipe-delimited tables.
 *
 * Images are configured to emit `<img src="">` (no base64 work) and the
 * turndown rule above replaces them with the literal `[image]` token.
 */
export async function extractDocxText(
  buffer: Buffer,
  options: DocxExtractOptions = {},
): Promise<DocxExtractionResult> {
  // Issue #424: reject decompression bombs from the central directory's
  // declared sizes before mammoth inflates anything.
  assertDocxDecompressedSizeWithinLimit(
    buffer,
    options.maxDecompressedBytes ?? MAX_DOCX_DECOMPRESSED_BYTES,
  );

  const { value: rawHtml } = await mammoth.convertToHtml(
    { buffer },
    {
      // Empty src skips mammoth's base64 encoding; the strip-image
      // turndown rule above replaces <img> with [image] downstream.
      convertImage: mammoth.images.imgElement(() =>
        Promise.resolve({ src: "" }),
      ),
    },
  );
  const html = normalizeTableHtml(rawHtml);
  const text = turndown.turndown(html);

  // Second defense layer: an archive that lied about its declared sizes
  // still cannot hand the model an unbounded extraction result.
  const maxTextBytes = options.maxTextBytes ?? MAX_DOCX_EXTRACTED_TEXT_BYTES;
  if (Buffer.byteLength(text, "utf-8") > maxTextBytes) {
    throw new Error(
      `DOCX extracted text (${Buffer.byteLength(text, "utf-8")} bytes) exceeds the limit (${maxTextBytes} bytes).`,
    );
  }
  return { text };
}

import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface DocxExtractionResult {
  text: string;
}

// Single shared turndown instance — config is pure, no per-call state.
// GFM plugin gives us pipe tables, strikethrough, and task-list rendering.
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
// Replace every <img> with a literal "[image]" token. Until vision lands,
// embedded images contribute no usable text — but the placeholder
// signals to the model that visual content was elided rather than missing.
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
 */
function normalizeTableHtml(html: string): string {
  // Step 1: strip <p> wrappers inside <td>/<th> cells.
  let out = html.replace(/<(td|th)([^>]*)><p>([\s\S]*?)<\/p><\/(td|th)>/g, "<$1$2>$3</$1>");

  // Step 2: for each <table>…</table>, promote the first <tr> into a
  // <thead> with <th> cells. Mammoth emits no <tbody>, so rows sit
  // directly under <table>.
  out = out.replace(/<table>([\s\S]*?)<\/table>/g, (_, inner: string) => {
    // Match the first <tr>…</tr> block.
    const firstRowMatch = inner.match(/^(<tr>[\s\S]*?<\/tr>)/);
    if (!firstRowMatch) return `<table>${inner}</table>`;
    const firstRow = firstRowMatch[1];
    const rest = inner.slice(firstRow.length);
    // Convert <td> → <th> so isHeadingRow() in the GFM plugin is satisfied.
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
): Promise<DocxExtractionResult> {
  const { value: rawHtml } = await mammoth.convertToHtml({
    buffer,
    convertImage: mammoth.images.imgElement(() =>
      Promise.resolve({ src: "" })
    ),
  });
  const html = normalizeTableHtml(rawHtml);
  const text = turndown.turndown(html);
  return { text };
}

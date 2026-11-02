// The .docx → Markdown conversion itself: mammoth → HTML → normalizeTableHtml
// → turndown. It runs in the reader CHILD (`docx-reader-child.ts`), never in
// the OpenClaw process: mammoth's DOM costs up to ~300x the markup it parses,
// and how much markup a package really holds is something only mammoth knows
// for sure (see `docx-extract.ts`).
//
// The child runs this file under Node's own type stripping, not tsx or jiti —
// the OpenClaw image has neither on a path a child can use. So it imports
// nothing but packages, and only syntax that strips cleanly (no enums, no
// parameter properties, type-only imports marked `type`).

import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

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
 * `packages/web/src/lib/attachment-adapters.ts`. Both must apply the same
 * transformations so KB reads and composer uploads produce identical table
 * Markdown. Intentional duplication: the web file uses dynamic imports for
 * bundle isolation; a shared package would complicate that.
 */
function normalizeTableHtml(html: string): string {
  let out = html.replace(/<(td|th)([^>]*)><p>([\s\S]*?)<\/p><\/(td|th)>/g, "<$1$2>$3</$1>");

  // Mammoth emits no <tbody>, so rows sit directly under <table>.
  out = out.replace(/<table>([\s\S]*?)<\/table>/g, (_, inner: string) => {
    const firstRowMatch = inner.match(/^(<tr>[\s\S]*?<\/tr>)/);
    if (!firstRowMatch) return `<table>${inner}</table>`;
    const firstRow = firstRowMatch[1];
    const rest = inner.slice(firstRow.length);
    const headingRow = firstRow.replace(/<td([^>]*)>/g, "<th$1>").replace(/<\/td>/g, "</th>");
    return `<table><thead>${headingRow}</thead><tbody>${rest}</tbody></table>`;
  });

  return out;
}

/**
 * A .docx as Markdown, or a throw when the Markdown is longer than
 * `maxTextBytes` — a document honestly within every archive limit can still
 * hold more text than the model should be handed.
 *
 * Mammoth's own `convertToMarkdown` is deprecated and degrades tables to one
 * paragraph per cell — the HTML route preserves table structure and
 * round-trips through turndown's GFM plugin as pipe-delimited tables. Images
 * are configured to emit `<img src="">` (no base64 work) and the turndown rule
 * above replaces them with the literal `[image]` token.
 *
 * Expects a VERIFIED archive (`verifiedZipCopy`), and must only ever run in
 * the reader child.
 */
export async function docxToMarkdown(buffer: Buffer, maxTextBytes: number): Promise<string> {
  const { value: rawHtml } = await mammoth.convertToHtml(
    { buffer },
    {
      // Empty src skips mammoth's base64 encoding; the strip-image
      // turndown rule above replaces <img> with [image] downstream.
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
    }
  );
  const text = turndown.turndown(normalizeTableHtml(rawHtml));
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes > maxTextBytes) {
    throw new Error(
      `DOCX extracted text (${bytes} bytes) exceeds the limit (${maxTextBytes} bytes).`
    );
  }
  return text;
}

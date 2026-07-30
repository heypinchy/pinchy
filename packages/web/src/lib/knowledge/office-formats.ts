/**
 * What counts as a page-shaped Office document, and what its converted PDF is
 * called. Two facts, needed on BOTH sides of the bundle boundary.
 *
 * No imports on purpose — same rule as `citation-path.ts`. The markdown
 * renderer decides client-side whether a citation is an Office source (it
 * offers a second download for one), and `office-convert.ts` decides the same
 * thing server-side. A single `node:path` import here would drag
 * `child_process` and pdfjs into the browser bundle along the same chain, so
 * the extension is read with string operations rather than `extname`.
 *
 * These constants used to live in `office-convert.ts`; they moved here when
 * the preview route (#939) and the renderer needed them, so the list stays one
 * list. `office-convert.ts` re-exports them, which is why its own tests still
 * read the same names.
 */

/**
 * The page-shaped Office formats. Spreadsheets are deliberately absent: a
 * sheet is not a page, and rendering one to PDF produces arbitrary page breaks
 * that no citation can honestly point at (#937/#940).
 */
export const OFFICE_EXTENSIONS = [".doc", ".docx", ".ppt", ".pptx"] as const;

/**
 * The lowercased extension of `path`, or "" — `node:path`'s `extname` written
 * as string surgery, including its rule that a leading dot is a dotfile and
 * not an extension (`.doc` → "", never ".doc").
 */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Is this a page-shaped Office document the knowledge base converts? */
export function isOfficeFile(path: string): boolean {
  return (OFFICE_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/**
 * What the converted PDF is called: the source's own name, carrying `.pdf`.
 *
 * `Angebot.doc` → `Angebot.pdf`, so the two downloads a reader is offered name
 * the same document and differ exactly where they differ — in the format. A
 * generic `converted.pdf` would arrive in their downloads folder saying
 * nothing about which document it is.
 */
export function convertedPdfName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = extensionOf(name);
  return `${ext ? name.slice(0, -ext.length) : name}.pdf`;
}

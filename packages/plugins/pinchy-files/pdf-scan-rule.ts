/**
 * The rule that decides whether a PDF page is a scan — shared, verbatim, by
 * the two places in Pinchy that read PDFs.
 *
 * ── Why this file exists, and why it lives HERE ───────────────────────────
 * A scanned page reaches a reader only through a vision model, and Pinchy
 * calls one from two containers: `pinchy-files` when an agent opens a PDF
 * (OpenClaw container), and the knowledge-base ingest when it indexes one
 * (Pinchy container). If those two disagree about which pages are scans — or
 * worse, about what a scan's text IS — then a citation points at a chunk the
 * agent cannot find when it opens the same file. That is the exact failure the
 * attribution graders exist to detect, and building it ourselves would be a
 * poor use of them.
 *
 * So the rule is single-sourced rather than reimplemented. It lives in the
 * PLUGIN, which looks like the wrong direction for a dependency — web is the
 * core, a plugin is an extension — and is nonetheless the only place it can
 * sit. A plugin is deployed as a self-contained directory (`sync-plugins.sh`
 * copies one directory per plugin; `Dockerfile.openclaw` runs `npm install`
 * against the plugin's own package.json in an isolated tmpdir), so it can
 * import nothing outside itself. Web is under no such constraint and reaches
 * across with a relative path — the same move `plugin-manifest-loader.ts`
 * already makes for the nine plugin manifests.
 *
 * That is also why this module has NO imports and must keep none: web pulls it
 * into `next build`, so every dependency added here becomes a web dependency,
 * and one that resolves out of a plugin's node_modules would not resolve at
 * all. `escapingImportTargets` in `scripts/lib/prepush-build-gate.mjs` is what
 * holds the classification honest.
 */

/**
 * A page carrying less text than this is not, on its own, a scan — a title
 * page and a separator are also short. It is the precondition, paired with
 * evidence that the page painted something.
 *
 * 200 characters is OpenClaw's own threshold for its built-in `pdf` tool's
 * extraction fallback, kept deliberately rather than tuned: two
 * implementations that disagree about the cut-off would classify differently
 * on exactly the borderline pages nobody tests.
 */
export const PDF_MIN_TEXT_CHARS = 200;

/** Whether a page's own text is too sparse to serve a reader on its own. */
export function hasSparseText(text: string): boolean {
  return text.length < PDF_MIN_TEXT_CHARS;
}

/**
 * How large a page may be rendered before it is scaled down, in pixels.
 *
 * The BUDGET is shared; the render CALL is not, and that split is the point.
 * `pinchy-files` and `packages/web` resolve different pdfjs majors (5.x and
 * 6.x), whose `page.render()` parameters differ — a shared render function
 * would be type-checked against one and executed against the other. So each
 * side owns its own ~20-line renderer and both read the budget from here,
 * which is the part that must not drift: it decides how much of a page a
 * vision model actually gets to see, and two documents rendered at different
 * resolutions read differently to the same model.
 *
 * 4,000,000 is OpenClaw's own budget for the built-in `pdf` tool.
 */
export const MAX_RENDER_PIXELS = 4_000_000;

/**
 * Whether a page should be treated as a scan — i.e. rendered to PNG and handed
 * to a vision model instead of being served as its (near-empty) text layer.
 *
 * `imageSizeUnknown` is set when the page provably painted an image and its
 * size was not established. In that state the page has already shown it is not
 * a plain text page, so the safe reading is "scan": the reader gets a picture
 * that can actually be read. The alternative — the behaviour this replaces —
 * was to silently classify it as text and hand over a blank page.
 *
 * Both callers reach that state, for different reasons, and the flag covers
 * both: `pinchy-files` when its size lookup times out under a decode budget,
 * the ingest extractor because it never measures sizes at all. Measuring means
 * resolving every image object on the page, and at index time — whole corpus,
 * no agent waiting — the cheaper reading is the right trade: a wrongly
 * rendered blank page costs one vision call, a wrongly skipped scan costs a
 * document nobody can search.
 */
export function isScannedPage(opts: {
  sparseText: boolean;
  hasLargeImages: boolean;
  imageSizeUnknown: boolean;
}): boolean {
  return opts.sparseText && (opts.hasLargeImages || opts.imageSizeUnknown);
}

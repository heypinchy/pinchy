/**
 * Where inside a document a chunk sits — the anchor a citation points at.
 *
 * `kb_chunks` used to carry a bare `page`, which only PDFs have. Each format
 * needs a different anchor, and the reason is not cosmetic:
 *
 *   PDF          page          intrinsic
 *   PowerPoint   slide number  intrinsic, and slide N is PDF page N
 *   Spreadsheet  sheet + rows  intrinsic
 *   Word         heading path  pagination is a RENDERING result (fonts,
 *                              printer metrics, Word vs LibreOffice), so a
 *                              page number is not a property of the document
 *                              the reader opens
 *
 * Forcing every format onto "page" would make a citation state something that
 * is false of the file the user opens. Hence a CLOSED, typed union rather than
 * a free-form string: Wave 2 adds one producer per format against it, and a
 * stringly-typed anchor is exactly what would let two of them drift apart.
 *
 * ── Duplicated on purpose ────────────────────────────────────────────────
 * This file exists twice, byte-for-byte:
 *   packages/web/src/lib/knowledge/locator.ts
 *   packages/plugins/pinchy-knowledge/locator.ts
 * The plugin is a separate package that cannot import from the web app (the
 * same bundle-isolation reason `normalizeTableHtml` is duplicated), yet it is
 * the layer that RENDERS the citation. `chunk-locator-drift.test.ts` pins the
 * two copies to be identical modulo comments and whitespace, so a fifth kind
 * added on one side cannot silently go unrendered on the other.
 */

export type ChunkLocator =
  /** A PDF page, 1-based. */
  | { kind: "page"; page: number }
  /** A presentation slide, 1-based. */
  | { kind: "slide"; slide: number }
  /**
   * A Word heading path from the document's outline, outermost first
   * (`["Quality", "Incoming goods"]`). Producers must supply at least one
   * heading — a document with no outline at all has no stable anchor and its
   * chunks carry a null locator instead.
   */
  | { kind: "heading"; headings: string[] }
  /**
   * A spreadsheet sheet and the 1-based, inclusive row range the chunk spans.
   * Field-for-field what `xlsx-extract.ts`'s `XlsxChunk` already produces, so
   * wiring that extractor into the ingest is a spread rather than a mapping.
   */
  | { kind: "sheet"; sheet: string; startRow: number; endRow: number };

/**
 * Renders a locator as the parenthesised hint that follows a document path in
 * a citation ("p. 12", "slide 4", "§ Quality > Incoming goods").
 *
 * The switch deliberately has no `default`: with an explicit `string` return
 * type, a fifth locator kind stops compiling here until it is given a
 * rendering, which is what keeps the union closed in practice rather than
 * merely in the type.
 */
export function formatLocator(locator: ChunkLocator): string {
  switch (locator.kind) {
    case "page":
      return `p. ${locator.page}`;
    case "slide":
      return `slide ${locator.slide}`;
    case "heading":
      return `§ ${locator.headings.join(" > ")}`;
    case "sheet":
      return locator.startRow === locator.endRow
        ? `${locator.sheet}, row ${locator.startRow}`
        : `${locator.sheet}, rows ${locator.startRow}-${locator.endRow}`;
  }
}

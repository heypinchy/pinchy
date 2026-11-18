/**
 * The anchor a converted Word document's chunks carry (#938).
 *
 * A Word document has no page number worth citing — pagination is a rendering
 * result, and LibreOffice's pages are not Word's (locator.ts). Its outline is
 * the anchor the reader can actually follow, and the extractor hands it over
 * as per-page marks saying where each section STARTS.
 *
 * Turning those marks into one locator per chunk is a document-wide question,
 * not a per-page one: a section that opens at the bottom of page 3 owns all of
 * page 4, and the text at the top of a page that opens a new section still
 * belongs to the previous one. Both are ordinary in a real document, and both
 * are what a page-level reading gets wrong.
 *
 * Kept apart from ingest.ts and free of pdfjs so the rule can be read and
 * tested on its own.
 */
import type { ChunkLocator } from "./locator";
import type { IngestPage } from "./types";

/** One heading section, positioned in the document rather than in a page. */
export interface HeadingSection {
  page: number;
  charStart: number;
  headings: string[];
}

/** Flattens the per-page marks of `pages` into document order. */
export function collectHeadingSections(pages: readonly IngestPage[]): HeadingSection[] {
  const sections: HeadingSection[] = [];
  for (const page of pages) {
    for (const mark of page.headings ?? []) {
      sections.push({ page: page.page, charStart: mark.charStart, headings: mark.headings });
    }
  }
  return sections;
}

/**
 * The section a chunk starting at (`page`, `charStart`) sits in, or null when
 * nothing precedes it.
 *
 * Null is a real answer, not a gap: a cover page, or a document written
 * without heading styles, has no stable anchor at all — and #938 says it
 * plainly, an omitted locator beats one that does not match what the reader
 * sees in Word.
 *
 * A chunk that begins before a heading but runs past it keeps the earlier
 * section. Where a chunk STARTS is what decides, because that is the text the
 * retrieved passage opens with.
 */
export function headingLocatorAt(
  sections: readonly HeadingSection[],
  page: number,
  charStart: number
): ChunkLocator | null {
  let found: HeadingSection | null = null;
  for (const section of sections) {
    const started =
      section.page < page || (section.page === page && section.charStart <= charStart);
    if (!started) break;
    found = section;
  }
  return found ? { kind: "heading", headings: found.headings } : null;
}

/**
 * A PDF's outline (bookmarks), read the same way on both sides of a Word
 * citation (#938, #1268).
 *
 * The indexer files every chunk of a converted Word document under a heading
 * path, and that path is THIS outline: LibreOffice exports Word's headings as
 * PDF bookmarks (`pdf-extract.ts`). The citation viewer later has to turn the
 * path back into pages of the same PDF. If the two sides flattened the outline
 * differently — one trimming a title, the other not — the viewer would look
 * for a heading the index never wrote, and the highlight would just not
 * appear, with nothing red anywhere. So there is one reading, here, and both
 * use it.
 *
 * Free of pdf.js on purpose: it takes the three document methods it reads, so
 * the server's pdf.js and the browser's both fit, and tests need neither.
 */
import { locatePassage } from "@/lib/knowledge/passage-match";

/** The subset of a pdf.js document the outline is read through. */
export interface OutlineSource {
  getOutline(): Promise<unknown>;
  getDestination(id: string): Promise<unknown[] | null>;
  /** Method syntax on purpose: pdf.js types the ref as its own `RefProxy`. */
  getPageIndex(ref: never): Promise<number>;
}

/** One heading, where its destination points. */
export interface OutlineEntry {
  /** 1-based page the heading's destination names. */
  page: number;
  /**
   * The destination's top edge, or null when it names no coordinate. Only
   * `/XYZ` carries one, which is what LibreOffice writes for a Word heading;
   * every other destination type genuinely means "this page".
   */
  top: number | null;
  /** The heading path, outermost first. Never empty. */
  headings: string[];
}

interface OutlineNode {
  title?: string;
  dest?: string | unknown[] | null;
  items?: OutlineNode[];
}

/** The y a destination names, or null when it names none. */
function destinationTop(dest: unknown[]): number | null {
  const type = (dest[1] as { name?: string } | undefined)?.name;
  return type === "XYZ" && typeof dest[3] === "number" ? dest[3] : null;
}

/**
 * The outline flattened to one entry per heading, in document order.
 *
 * An outline this cannot read is not an error: the document simply has no
 * headings to anchor on — the normal state of a Word file written without
 * heading styles.
 */
export async function flattenOutline(doc: OutlineSource): Promise<OutlineEntry[]> {
  let outline: OutlineNode[] | null;
  try {
    outline = (await doc.getOutline()) as OutlineNode[] | null;
  } catch {
    return [];
  }
  if (!outline) return [];

  const entries: OutlineEntry[] = [];
  const visit = async (nodes: OutlineNode[], path: string[]): Promise<void> => {
    for (const node of nodes) {
      const title = (node.title ?? "").trim();
      // An untitled entry adds no level rather than an empty one: "§ Quality >
      //  > Zone B" names a section nobody can find.
      const headings = title ? [...path, title] : path;

      if (headings.length > 0) {
        try {
          const dest =
            typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
          if (Array.isArray(dest) && dest.length > 0) {
            const page = (await doc.getPageIndex(dest[0] as never)) + 1;
            entries.push({ page, top: destinationTop(dest), headings });
          }
        } catch {
          // A destination that will not resolve costs its own heading and
          // nothing else — the rest of the outline still anchors.
        }
      }

      if (node.items?.length) await visit(node.items, headings);
    }
  };

  await visit(outline, []);
  return entries;
}

/**
 * A heading path as one string, the way a citation shows it
 * (`formatLocator`: "§ Quality > Incoming goods" without the "§ ").
 *
 * Headings are compared in this joined form, on the server and here, rather
 * than as arrays: the citation text is all the viewer has, and a title that
 * itself contains " > " splits into a different array but joins back to the
 * same string.
 */
export function joinHeadings(headings: readonly string[]): string {
  return headings.join(" > ");
}

/**
 * The pages a chunk filed under `heading` can sit on, or null when the outline
 * has no such heading.
 *
 * The index files a chunk under the latest section started before it, at any
 * level (`headingLocatorAt`). So the section runs from its own page to the
 * page the NEXT outline entry starts on — inclusive, because that entry may
 * start halfway down its page, below the end of this section.
 */
export function sectionPages(
  entries: readonly OutlineEntry[],
  heading: string,
  numPages: number
): { first: number; last: number } | null {
  const index = entries.findIndex((entry) => joinHeadings(entry.headings) === heading);
  if (index === -1) return null;

  const first = entries[index].page;
  const next = entries[index + 1];
  const end = next ? Math.min(next.page, numPages) : numPages;
  return { first, last: Math.max(first, end) };
}

/**
 * Most pages of one section scanned for its passage. A section is usually a
 * few pages; this bounds the cost of one that is not — a long chapter with no
 * sub-headings — at one section's worth of Range requests instead of a whole
 * document's.
 */
export const MAX_SECTION_SCAN_PAGES = 25;

/**
 * The page of `range` whose text holds `passage`, or the section's first page
 * when there is no passage or it is not found within the cap.
 *
 * Pages are read one at a time and the scan stops at the first match: a page's
 * text is a network round trip in the viewer, and the passage is most often
 * near the heading. The first page is the honest answer when nothing matched —
 * the reader still lands on the section the answer cited.
 */
export async function findSectionPage(
  pages: { pageRuns(pageNumber: number): Promise<string[]> },
  range: { first: number; last: number },
  passage: string | null
): Promise<number> {
  if (!passage) return range.first;

  const last = Math.min(range.last, range.first + MAX_SECTION_SCAN_PAGES - 1);
  for (let n = range.first; n <= last; n++) {
    let runs: string[];
    try {
      runs = await pages.pageRuns(n);
    } catch {
      continue;
    }
    if (locatePassage(runs, passage)) return n;
  }
  return range.first;
}

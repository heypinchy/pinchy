/**
 * Finds a knowledge-base passage among the text runs of a rendered PDF page,
 * so the citation viewer can highlight it (#1268).
 *
 * The passage is a chunk the index built from this very page: `pdf-extract.ts`
 * took pdf.js's `getTextContent()` runs, joined them with spaces, and broke
 * lines at each end-of-line run. The browser runs the same pdf.js over the same
 * bytes, so once ALL whitespace is removed on both sides the chunk is an exact
 * substring of the page. Comparing without whitespace is therefore not a
 * fuzzy-match heuristic — it is undoing the one transformation the extractor
 * applied.
 *
 * When the exact match fails (a run read differently, a page whose text came
 * from OCR rather than its text layer) the passage's two ends are tried as
 * anchors. Failing that: null. A missing highlight leaves the reader on the
 * right page; a wrong one tells them the answer came from text it did not.
 *
 * Returns the indices of the runs to highlight, ascending.
 */

/** Below this many non-space characters a passage says nothing about where it is. */
const MIN_PASSAGE_CHARS = 12;

/** Longest anchor tried at each end of a passage whose middle did not match. */
const MAX_ANCHOR_CHARS = 60;

/**
 * How much longer than the passage the region between two anchors may be. A
 * small slack for runs the two extractions spaced differently; far beyond it,
 * the anchors found two unrelated places on the page.
 */
const MAX_SPAN_RATIO = 1.5;

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

export function locatePassage(runs: readonly string[], passage: string): number[] | null {
  const needle = stripWhitespace(passage);
  if (needle.length < MIN_PASSAGE_CHARS) return null;

  // The page as one whitespace-free string, with the run each character came from.
  let haystack = "";
  const owner: number[] = [];
  runs.forEach((run, index) => {
    const stripped = stripWhitespace(run);
    haystack += stripped;
    for (let i = 0; i < stripped.length; i++) owner.push(index);
  });
  if (haystack.length === 0) return null;

  const exact = haystack.indexOf(needle);
  if (exact !== -1) return runsBetween(owner, exact, exact + needle.length);

  const anchor = Math.min(MAX_ANCHOR_CHARS, Math.floor(needle.length / 3));
  if (anchor < MIN_PASSAGE_CHARS) return null;

  const start = haystack.indexOf(needle.slice(0, anchor));
  if (start === -1) return null;
  const tail = needle.slice(-anchor);
  const tailAt = haystack.indexOf(tail, start + anchor);
  if (tailAt === -1) return null;

  const end = tailAt + tail.length;
  if (end - start > needle.length * MAX_SPAN_RATIO) return null;
  return runsBetween(owner, start, end);
}

function runsBetween(owner: number[], start: number, end: number): number[] {
  const first = owner[start];
  const last = owner[end - 1];
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

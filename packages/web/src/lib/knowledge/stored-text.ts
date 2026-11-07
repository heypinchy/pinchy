import type { ChunkLocator } from "./locator";

/**
 * What the knowledge base may store from a document, and which database
 * errors are a verdict on that document rather than on the database (#1366).
 *
 * Postgres cannot hold U+0000 in a `text` or `jsonb` value, and some PDFs and
 * workbooks carry it in their text layer or a sheet name. One such file used
 * to fail the whole index run on every rerun, because the batched chunk insert
 * was rejected and the error was treated as an outage.
 */

// NUL is removed outright: it is never a character a reader sees. The other C0
// controls (except tab, line feed, carriage return, which chunking reads) are
// replaced with a space, because a PDF text layer uses them where a separator
// was, and dropping them would glue two words into one no search finds.
// eslint-disable-next-line no-control-regex
const NUL = /\u0000/g;
// eslint-disable-next-line no-control-regex
const OTHER_C0 = /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g;

/** `text` with every character Postgres or the index has no use for removed. */
export function toStorableText(text: string): string {
  return text.replace(NUL, "").replace(OTHER_C0, " ");
}

/** The same cleaning for the strings a locator carries into `jsonb`. */
export function toStorableLocator(locator: ChunkLocator | null): ChunkLocator | null {
  if (locator === null) return null;
  switch (locator.kind) {
    case "sheet":
      return { ...locator, sheet: toStorableText(locator.sheet) };
    case "heading":
      return { ...locator, headings: locator.headings.map(toStorableText) };
    default:
      return locator;
  }
}

// The SQLSTATE classes that judge the values of one statement:
//   22  data exception (an encoding Postgres refuses, a vector of the wrong width)
//   23  integrity constraint violation
//   54  program limit exceeded (a value or row too large)
// Everything else — a lost connection, too many clients, a shutdown, a
// serialization failure — says nothing about the file, and must still stop the
// run instead of being counted as one failed file per remaining document.
const CONTENT_REJECTION = /^(22|23|54)[0-9A-Z]{3}$/;

/**
 * The database error that refused this content, when `err` is one — found
 * through the cause chain, because the query builder wraps it in an error
 * whose message quotes every parameter, chunk text included.
 */
export function isContentRejection(err: unknown): Error | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONTENT_REJECTION.test(code)) return current;
    current = current.cause;
  }
  return null;
}

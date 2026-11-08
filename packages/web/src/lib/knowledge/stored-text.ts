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
const NUL = /\u0000/g;
const OTHER_C0 = /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g;
// A lone UTF-16 surrogate becomes U+FFFD in a text column, but jsonb receives
// it as a `\ud800` escape and refuses it, so it is replaced the same way here.
const LONE_SURROGATE = /\p{Cs}/gu;

/** `text` with every character Postgres or the index has no use for removed. */
export function toStorableText(text: string): string {
  return text.replace(NUL, "").replace(OTHER_C0, " ").replace(LONE_SURROGATE, "\ufffd");
}

/** The same cleaning for the strings a locator carries into `jsonb`. */
export function toStorableLocator(locator: ChunkLocator | null): ChunkLocator | null {
  if (locator === null) return null;
  switch (locator.kind) {
    case "sheet":
      return { ...locator, sheet: toStorableText(locator.sheet) };
    case "heading": {
      // A level that held only control characters names nothing a reader could
      // look for, and an empty path is no locator at all.
      const headings = locator.headings.map((h) => toStorableText(h).trim()).filter(Boolean);
      return headings.length > 0 ? { ...locator, headings } : null;
    }
    default:
      return locator;
  }
}

// The SQLSTATE classes that judge the values of one statement:
//   22  data exception (an encoding Postgres refuses, a malformed value)
//   54  program limit exceeded (a value or row too large)
// Class 23 is deliberately not one of them: the knowledge tables carry no CHECK
// constraint a file's content could violate, so a 23xxx there is a concurrent
// writer or a bug in this code, and counting it as "N failed" would hide it.
// The embedding width is checked in the embedder before any write, so a wrong
// width never reaches here as a verdict on the file either. Which of the other
// errors stop the run and which cost only the file is decided in
// ./ingest-errors.ts (#1380).
const CONTENT_REJECTION = /^(22|54)[0-9A-Z]{3}$/;

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

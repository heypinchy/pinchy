/**
 * Which errors stop a knowledge-base run, and which cost only the file they
 * happened on (#1380).
 *
 * A real corpus is not a curated fixture: one PDF that does not parse, one
 * chunk the embedder refuses, one row the database will not take is normal,
 * and must not cost every file after it its update. So the default is the
 * file's failure — counted, logged, retried next run. Only an error that would
 * fail every remaining file the same way stops the run; counted per file
 * instead, a database restart mid-reindex would read as "11,000 failed" and the
 * job as done, burying the one fact an operator needs.
 *
 * The list is explicit and closed, like `isContentRejection` before it: adding
 * to it is a claim that the error says nothing about the file.
 */
import { EmbedderUnavailableError } from "./embeddings";

// SQLSTATE classes that describe the database, not the statement's values:
//   08  connection exception
//   53  insufficient resources (disk full, out of memory, too many clients)
//   57  operator intervention (shutdown, crash recovery, a cancelled query)
//   58  system error (I/O error in the database server)
const SYSTEMIC_SQLSTATE = /^(08|53|57|58)[0-9A-Z]{3}$/;

const SYSTEMIC_CODES = new Set([
  // postgres.js: the connection to the database is gone or never came up.
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
  // Node: the network under the database (or the embedder) is gone.
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);
// A full disk on Pinchy's side (ENOSPC, EDQUOT) is deliberately NOT here. It
// surfaces while one file is copied to staging or converted, and one file far
// larger than the space left would otherwise stop every run at that same file —
// the failure #1380 is about. It stays that file's failure, as documented
// ("a disk too full for the private copy a file is read from"); the database's
// own disk running full is class 53 above.

/**
 * The error that stops the run, when `err` is or wraps one — found through
 * the cause chain, because the query builder wraps the database's error in one
 * whose message quotes every parameter, chunk text included. Null when the
 * error belongs to the file.
 */
export function systemicIngestError(err: unknown): Error | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof EmbedderUnavailableError) return current;
    // The run was told to stop; finishing it file by file would ignore that.
    if (current.name === "AbortError") return current;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && (SYSTEMIC_SQLSTATE.test(code) || SYSTEMIC_CODES.has(code))) {
      return current;
    }
    current = current.cause;
  }
  return null;
}

/**
 * The database's own error behind `err`, or `err` itself: what a log line
 * should quote. Drizzle's wrapper message quotes every parameter of the failed
 * query — the document's text and its vectors — which a log line must neither
 * carry nor be truncated by.
 */
export function databaseErrorBehind(err: unknown): unknown {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return current;
    // A query builder's wrapper (it carries the query and its params) is never
    // what to quote, whatever its cause's code looks like: postgres.js raises
    // some errors client-side with codes like `MAX_PARAMETERS_EXCEEDED`.
    const isQueryWrapper = "params" in current && current.cause instanceof Error;
    if (!isQueryWrapper) return current;
    current = current.cause;
  }
  return err;
}

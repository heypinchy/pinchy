/**
 * The order a run ingests its files in (#1385).
 *
 * A first index of a large share takes days, and people start searching long
 * before it ends. Two rules make the part they search complete first:
 *
 * - **Archived files last.** Default retrieval hides them (archive-paths.ts),
 *   and on a real supplier share they were over a quarter of the chunks. Same
 *   total time, but every current document is searchable before the first
 *   archived one is read.
 * - **Folder by folder.** Within each group files are sorted by path, segment
 *   by segment, so a folder's files — its subfolders included — sit together
 *   and whole folders finish one after another. `readdir` order is whatever
 *   the file system returns, which on a network share is neither sorted nor
 *   stable between runs. The per-folder index status (#1386) reads progress
 *   against this order.
 *
 * Segment-wise rather than as plain strings: `Supplier A-Z/` would otherwise
 * land between `Supplier A/` and `Supplier A/sub/`, because `-` sorts before
 * `/`. Code-unit comparison, not `localeCompare`: the order must not depend on
 * the server's ICU data.
 */
import { isArchivedPath } from "./archive-paths";

function comparePaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return left.length - right.length;
}

/** `files` reordered for ingest: current before archived, each group folder by folder. */
export function orderForIngest<T extends { absPath: string }>(files: readonly T[]): T[] {
  const current: T[] = [];
  const archived: T[] = [];
  for (const file of files) (isArchivedPath(file.absPath) ? archived : current).push(file);
  const byPath = (a: T, b: T) => comparePaths(a.absPath, b.absPath);
  return [...current.sort(byPath), ...archived.sort(byPath)];
}

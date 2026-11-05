/**
 * Comparison helpers for directory grants (`pinchy-files.allowed_paths`).
 *
 * A stored grant may carry a trailing slash ("/data/x/"), for example one
 * written through the API or by an older version. No save path adds it today,
 * but `sanitizePath` in path-validation.ts produces that form, so it is valid
 * data. /api/data-directories lists mounts without one ("/data/x"). Compare
 * through these instead of `===` / `includes`, or a granted directory reads as
 * ungranted and cannot be revoked in the UI (#1264).
 *
 * Kept import-free: client components use it, and path-validation.ts pulls in
 * `node:path`. The stored format is deliberately not changed here.
 */
export function directoryKey(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function isSameDirectory(a: string, b: string): boolean {
  return directoryKey(a) === directoryKey(b);
}

/** True when both lists grant the same set of directories, in any order or spelling. */
export function sameDirectorySet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(directoryKey));
  const right = new Set(b.map(directoryKey));
  return left.size === right.size && [...left].every((key) => right.has(key));
}

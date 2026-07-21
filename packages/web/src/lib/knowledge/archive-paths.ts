/**
 * Archive-path classification for knowledge-base freshness gating (#858).
 *
 * A document is `archived` iff any DIRECTORY segment of its source path —
 * every segment except the basename — equals one of ARCHIVE_SEGMENT_NAMES,
 * case-insensitively. The rule is deliberately conservative:
 *
 * - Segment-exact, never substring: `OLD/` matches, `Goldakte/` and
 *   `old-versions/` do not. A false-positive archive flag hides a current
 *   document from default retrieval — the more expensive error.
 * - Directory segments only: a file named `archive.pdf` is not archived;
 *   the observed real-world signal is archive *folders* (Noack: `OLD/`).
 * - Year/date folders (`2013/`, `Q3/`) are never archives — consistent with
 *   exclude-globs.ts, they are almost always live structure.
 *
 * Archived documents are still fully ingested (chunked + embedded); the
 * status only gates default retrieval (`retrieve()` filters
 * `status = 'active'` unless `includeArchived` is set). The backfill
 * migration mirrors this rule as a SQL regex — a drift guard pins the two
 * together (see archive-paths-migration-drift test).
 */

/** Directory names (case-insensitive, segment-exact) that mark an archive subtree. */
export const ARCHIVE_SEGMENT_NAMES: readonly string[] = ["old", "archive", "archived", "archiv"];

/** True iff any directory segment of `sourcePath` is an archive folder name. */
export function isArchivedPath(sourcePath: string): boolean {
  const segments = sourcePath.split("/");
  // Drop the basename: the rule targets directories only.
  return segments
    .slice(0, -1)
    .some((segment) => ARCHIVE_SEGMENT_NAMES.includes(segment.toLowerCase()));
}

/** The kb_documents.status the archive rule assigns to `sourcePath`. */
export function statusForPath(sourcePath: string): "active" | "archived" {
  return isArchivedPath(sourcePath) ? "archived" : "active";
}

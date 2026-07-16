/**
 * Ingest-side file exclusions (design §7a).
 *
 * Mature connectors (Onyx, Elastic, Bedrock, LlamaIndex) filter primarily by
 * an **extension allowlist + skip-hidden**, not a large junk denylist. We
 * follow the same three-layer posture:
 *
 *   1. Extension allowlist (primary) — only known doc types are indexed.
 *   2. Skip-hidden — any path segment with a `.` prefix is skipped.
 *   3. Denylist (secondary) — OS/temp/backup artifacts within accepted
 *      types.
 *
 * This module only covers tiers 1-3's "A/B" (OS artifacts, temp/backup/lock
 * files): safe, ingest-side, practically never legitimate. §7a's "C/D" tier
 * (archive-folder heuristics like `OLD/`, `Archive/`) is deliberately NOT
 * here — the design calls that a **query-time, per-agent curation filter**
 * (Task 7+), not an ingest default. Date/year folders (`2020/`, `Q3/`) are
 * intentionally never excluded anywhere: they're almost always live
 * structure, not junk.
 *
 * Kept as plain data + small predicates (no glob DSL) so it's easy to read,
 * test, and override.
 */

/** File extensions eligible for ingest. MVP (Scope A) is text PDFs only. */
export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = [".pdf"];

/** Exact (case-insensitive) file names that are always OS artifacts. */
const DENYLIST_EXACT_NAMES: readonly string[] = ["thumbs.db", "desktop.ini"];

/**
 * Case-insensitive file-name prefixes indicating a temp/lock artifact.
 * `.ds_store` and `._*` (AppleDouble) are also covered by the skip-hidden
 * rule since they start with `.`, but are listed here too for clarity.
 */
const DENYLIST_NAME_PREFIXES: readonly string[] = ["._", "~$", ".ds_store"];

/** Case-insensitive file-name suffixes indicating a temp/backup artifact. */
const DENYLIST_NAME_SUFFIXES: readonly string[] = [
  ".tmp",
  ".bak",
  "~",
  ".swp",
  ".crdownload",
  ".part",
];

/** Case-insensitive directory names whose entire subtree is skipped. */
const DENYLIST_DIR_NAMES: readonly string[] = ["$recycle.bin", "system volume information"];

/** True if `name` (a path segment, file or dir) is hidden (dotfile). */
export function isHiddenSegment(name: string): boolean {
  return name.startsWith(".");
}

/** True if `name` (a file's base name) matches an A/B junk pattern. */
export function isDenylistedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DENYLIST_EXACT_NAMES.includes(lower) ||
    DENYLIST_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    DENYLIST_NAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

/** True if `name` (a directory's base name) is an OS-reserved junk folder. */
export function isDenylistedDirName(name: string): boolean {
  return DENYLIST_DIR_NAMES.includes(name.toLowerCase());
}

/** True if `fileName`'s extension is in the allowlist (case-insensitive). */
export function isAllowedExtension(
  fileName: string,
  allowedExtensions: readonly string[] = DEFAULT_ALLOWED_EXTENSIONS
): boolean {
  const lower = fileName.toLowerCase();
  return allowedExtensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

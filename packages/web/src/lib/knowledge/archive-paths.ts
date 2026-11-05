/**
 * Archive-path classification for knowledge-base freshness gating (#858).
 *
 * A document is `archived` iff any DIRECTORY segment of its source path —
 * every segment except the basename — contains an archive word as a whole
 * TOKEN. A segment's tokens are its runs of letters (see LETTER_CLASS): `_`,
 * `-`, spaces, digits and punctuation all separate them. Matching is
 * case-insensitive.
 *
 * - Token, not substring (#1290): `X_OLD/`, `Old certificates/`,
 *   `older versions/` and `OLD2019/` match; `Gold/`, `Folder/`, `Malt/` and
 *   `healthcare/` do not, because the letters sit inside a longer word. A
 *   false-positive archive flag hides a current document from default
 *   retrieval — the more expensive error.
 * - `xold` is a token of its own: `xOLD/` is the glued form of `X_OLD/`.
 * - `alt` (German "old") is deliberately NOT an archive word. As a token it
 *   is just as often "alternative" (`Logo alt/`, `ALT layouts/`), and German
 *   archives are almost always called `Archiv/`, which is covered. The
 *   inflected `alte`/`ältere` (`Alte Versionen/`) are unambiguous and count;
 *   `alter` does not — it is also "age".
 * - Case changes do not split a word: `OldVersions/` is one token and is not
 *   flagged (Postgres's `~*` cannot express a case boundary, so the SQL mirror
 *   could not follow). `xold` covers the one glued form seen in practice.
 * - A current folder whose name uses an archive word on its own
 *   (`Old Mill Foods/`) is archived too. Accepted: `old inserts/` and
 *   `Old MSDS/` need exactly that reading.
 * - A letter is an ASCII letter or a Latin accented one (U+00C0–U+024F,
 *   without × and ÷), spelled as explicit code-point ranges. So
 *   `Archivübersicht/` stays one word, and the rule reads the same in
 *   TypeScript and in the backfill migration's Postgres regex: Postgres's
 *   `[[:alpha:]]` depends on the database locale (`ü` is a letter under
 *   `en_US.utf8` and not under `C`). Other scripts separate tokens.
 * - Directory segments only: a file named `archive.pdf` is not archived;
 *   the observed real-world signal is archive *folders*.
 * - Year/date folders (`2013/`, `Q3/`) are never archives — consistent with
 *   exclude-globs.ts, they are almost always live structure.
 *
 * Archived documents are still fully ingested (chunked + embedded); the
 * status only gates default retrieval (`retrieve()` filters
 * `status = 'active'` unless `includeArchived` is set). The backfill
 * migration (0057) mirrors this rule as a SQL regex — a drift guard pins the
 * two together (migration-kb-archive-backfill integration test).
 */

/** Words (case-insensitive, whole tokens of a directory name) that mark an archive subtree. */
export const ARCHIVE_TOKENS: readonly string[] = [
  "old",
  "older",
  "xold",
  "archive",
  "archived",
  "archiv",
  "archives",
  "archiviert",
  "alte",
  "ältere",
  "veraltet",
  "expired",
  "obsolete",
];

/** One letter, as code-point ranges. Mirrored verbatim in migration 0057's regex. */
const LETTER_CLASS = "a-zA-Z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F";
const NON_LETTER_RUN = new RegExp(`[^${LETTER_CLASS}]+`);

/** True iff any directory segment of `sourcePath` holds an archive word as a token. */
export function isArchivedPath(sourcePath: string): boolean {
  const segments = sourcePath.split("/");
  // Drop the basename: the rule targets directories only.
  return segments.slice(0, -1).some((segment) =>
    segment
      // Split first, then lowercase: lowercasing can move a character into
      // or out of LETTER_CLASS (`İ`, `ẞ`), which Postgres does not do.
      .split(NON_LETTER_RUN)
      .some((token) => ARCHIVE_TOKENS.includes(token.toLowerCase()))
  );
}

/** The kb_documents.status the archive rule assigns to `sourcePath`. */
export function statusForPath(sourcePath: string): "active" | "archived" {
  return isArchivedPath(sourcePath) ? "archived" : "active";
}

/**
 * Archive-path classification for knowledge-base freshness gating (#858).
 *
 * A document is `archived` iff any DIRECTORY segment of its path INSIDE the
 * knowledge-base folder — every segment below the folder, except the basename
 * — contains an archive word as a whole TOKEN. A segment's tokens are its runs of letters (see LETTER_CLASS): `_`,
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
 * - Only the path below the granted folder counts (#1420). The folders above
 *   it are where the share happens to be mounted (`/data/Archiv/Projekte/`),
 *   not a statement about its documents' age — reading them archived every
 *   document of such a share. So a folder called `Archiv/` that is itself
 *   granted keeps its contents current, a file directly in the folder is
 *   never archived, and neither is a single file granted on its own. A folder
 *   reached through a symlink is read by the path below the link, as written.
 * - With nested grants, the INNERMOST folder holding the document decides
 *   (`isArchivedUnder`). `status` is one value per document for the whole org,
 *   so it must not depend on which agent's run reaches the document; the
 *   indexer therefore classifies against every folder any agent searches. One
 *   agent searching `/data/share/` and another searching only
 *   `/data/share/Archiv/` makes that archive folder current for both — the
 *   cheaper error, since a false `archived` hides a current document.
 *
 * Archived documents are still fully ingested (chunked + embedded); the
 * status only gates default retrieval (`retrieve()` filters
 * `status = 'active'` unless `includeArchived` is set). The backfill
 * migration (0057) mirrors the token rule (`isArchivedPath`) as a SQL regex —
 * a drift guard pins the two together (migration-kb-archive-backfill
 * integration test). That migration read whole paths; rows it archived wrongly
 * are corrected by the next index run, which re-derives every status.
 */

import { directoryKey } from "../directory-path";

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

/**
 * True iff any directory segment of `pathInKb` holds an archive word as a
 * token. `pathInKb` is the path BELOW the knowledge-base folder — classify a
 * real document through `isArchivedUnder`, which cuts it there.
 */
export function isArchivedPath(pathInKb: string): boolean {
  const segments = pathInKb.split("/");
  // Drop the basename: the rule targets directories only.
  return segments.slice(0, -1).some((segment) =>
    segment
      // Split first, then lowercase: lowercasing can move a character into
      // or out of LETTER_CLASS (`İ`, `ẞ`), which Postgres does not do.
      .split(NON_LETTER_RUN)
      .some((token) => ARCHIVE_TOKENS.includes(token.toLowerCase()))
  );
}

/**
 * `absPath` relative to the innermost of `roots` that holds it — empty for a
 * root that is the file itself. Throws when no root holds it: every document
 * the indexer classifies was found under one of its roots, so a miss means
 * the caller passed the wrong roots, and guessing would archive or surface
 * the document at random.
 */
export function kbRelativePath(absPath: string, roots: readonly string[]): string {
  let innermost: string | null = null;
  for (const root of roots) {
    const key = directoryKey(root);
    const holds = absPath === key || absPath.startsWith(key === "/" ? "/" : `${key}/`);
    if (holds && (innermost === null || key.length > innermost.length)) innermost = key;
  }
  if (innermost === null) {
    throw new Error(`${absPath} is not inside any knowledge-base folder it was classified against`);
  }
  if (absPath === innermost) return "";
  return absPath.slice(innermost === "/" ? 1 : innermost.length + 1);
}

/** True iff `absPath` sits in an archive folder below the innermost of `roots` that holds it. */
export function isArchivedUnder(absPath: string, roots: readonly string[]): boolean {
  return isArchivedPath(kbRelativePath(absPath, roots));
}

/** The kb_documents.status the archive rule assigns to `absPath` under `roots`. */
export function statusForPath(absPath: string, roots: readonly string[]): "active" | "archived" {
  return isArchivedUnder(absPath, roots) ? "archived" : "active";
}

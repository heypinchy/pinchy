/**
 * Pure logic for the drizzle-snapshot integrity check.
 *
 * Background: in PR #334 the commit `9a2e8be80` shipped a new migration's
 * SQL and journal entry but forgot to stage the matching `_snapshot.json`.
 * The lapse only surfaced days later in CI, when the snapshot-chain test
 * landed on main. This helper exists so we can catch the same mistake
 * locally (pre-commit) and in CI (drift check).
 *
 * Inputs are plain data so the rule is unit-testable without touching disk;
 * the wrapper script gathers journal/git/fs state and feeds it in.
 *
 * @param {object} input
 * @param {Array<{idx: number, tag: string}>} input.journalEntries
 *   Parsed `_journal.json#entries` — what drizzle THINKS exists.
 * @param {string[]} input.existingSnapshotFilenames
 *   Basenames of files currently in `drizzle/meta/` — what's ACTUALLY on disk.
 * @param {string[]} input.stagedSqlBasenames
 *   Basenames of newly-added `NNNN_*.sql` files staged for THIS commit
 *   (`git diff --cached --name-only --diff-filter=A`).
 * @param {string[]} input.stagedSnapshotBasenames
 *   Basenames of `NNNN_snapshot.json` files staged for THIS commit
 *   (any change type — created or modified).
 * @returns {string[]} Human-readable issue messages. Empty array = OK.
 */
export function findSnapshotIssues({
  journalEntries,
  existingSnapshotFilenames,
  stagedSqlBasenames,
  stagedSnapshotBasenames,
}) {
  const issues = [];
  const presentSnapshots = new Set(
    existingSnapshotFilenames.filter((f) => /^\d{4}_snapshot\.json$/.test(f))
  );
  const stagedSnapshots = new Set(stagedSnapshotBasenames);

  // Rule 1: every journal entry must have a snapshot file on disk.
  for (const entry of journalEntries) {
    const expected = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
    if (!presentSnapshots.has(expected)) {
      issues.push(
        `Journal references migration "${entry.tag}" (idx=${entry.idx}) but ${expected} is missing from drizzle/meta/. Run \`pnpm -C packages/web db:generate\` and commit the resulting snapshot.`
      );
    }
  }

  // Rule 2: when a new migration .sql is staged, its snapshot must also be
  // staged (drizzle generated both in the same step; staging only the .sql
  // is the typical mistake).
  for (const sql of stagedSqlBasenames) {
    const match = sql.match(/^(\d{4})_.*\.sql$/);
    if (!match) continue;
    const idx = match[1];
    const expectedSnapshot = `${idx}_snapshot.json`;
    if (!stagedSnapshots.has(expectedSnapshot)) {
      issues.push(
        `Staged migration ${sql} but its companion ${expectedSnapshot} is not staged for this commit. Did you forget \`git add packages/web/drizzle/meta/${expectedSnapshot}\` after running \`pnpm db:generate\`?`
      );
    }
  }

  return issues;
}

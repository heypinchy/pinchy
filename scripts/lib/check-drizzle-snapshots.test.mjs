import { test } from "node:test";
import assert from "node:assert/strict";
import { findSnapshotIssues } from "./check-drizzle-snapshots.mjs";

// Pure-function tests for the snapshot-integrity check that the pre-commit
// hook and CI run. The check guards against two failure modes that bit us in
// PR #334:
//
//   1. A migration .sql is committed without its matching _snapshot.json —
//      `git add packages/web/drizzle/0031_*.sql` succeeds; `git add
//      packages/web/drizzle/meta/0031_snapshot.json` is forgotten.
//
//   2. The journal lists a migration that has no snapshot file at all in
//      `drizzle/meta/` — the chain is broken silently until someone runs the
//      drizzle CLI or `migration-snapshots.test.ts`.

test("happy path: every journal entry has a snapshot, no issues", () => {
  const issues = findSnapshotIssues({
    journalEntries: [
      { idx: 0, tag: "0000_init" },
      { idx: 1, tag: "0001_add_users" },
    ],
    existingSnapshotFilenames: ["0000_snapshot.json", "0001_snapshot.json"],
    stagedSqlBasenames: [],
    stagedSnapshotBasenames: [],
  });
  assert.deepEqual(issues, []);
});

test("flags journal entry with missing snapshot file", () => {
  const issues = findSnapshotIssues({
    journalEntries: [
      { idx: 0, tag: "0000_init" },
      { idx: 1, tag: "0001_add_users" },
    ],
    existingSnapshotFilenames: ["0000_snapshot.json"], // 0001 missing
    stagedSqlBasenames: [],
    stagedSnapshotBasenames: [],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /0001_snapshot\.json/);
  assert.match(issues[0], /0001_add_users/);
});

test("flags multiple missing snapshots", () => {
  const issues = findSnapshotIssues({
    journalEntries: [
      { idx: 0, tag: "0000_init" },
      { idx: 1, tag: "0001_users" },
      { idx: 2, tag: "0002_groups" },
    ],
    existingSnapshotFilenames: ["0000_snapshot.json"],
    stagedSqlBasenames: [],
    stagedSnapshotBasenames: [],
  });
  assert.equal(issues.length, 2);
});

test("flags newly-staged SQL without its snapshot also being staged", () => {
  const issues = findSnapshotIssues({
    journalEntries: [
      { idx: 0, tag: "0000_init" },
      { idx: 1, tag: "0001_add_column" },
    ],
    existingSnapshotFilenames: ["0000_snapshot.json", "0001_snapshot.json"],
    stagedSqlBasenames: ["0001_add_column.sql"],
    stagedSnapshotBasenames: [], // forgot to stage snapshot
  });
  // The snapshot exists on disk (drizzle wrote it) but isn't staged for this
  // commit — exactly the trap from PR #334 where `git add` was selective.
  assert.equal(issues.length, 1);
  assert.match(issues[0], /0001_snapshot\.json/);
  assert.match(issues[0], /stage|git add/i);
});

test("staged SQL with staged snapshot is OK", () => {
  const issues = findSnapshotIssues({
    journalEntries: [
      { idx: 0, tag: "0000_init" },
      { idx: 1, tag: "0001_add_column" },
    ],
    existingSnapshotFilenames: ["0000_snapshot.json", "0001_snapshot.json"],
    stagedSqlBasenames: ["0001_add_column.sql"],
    stagedSnapshotBasenames: ["0001_snapshot.json"],
  });
  assert.deepEqual(issues, []);
});

test("handles 4-digit zero-padded indexes correctly (e.g. idx 31 → 0031_snapshot.json)", () => {
  const issues = findSnapshotIssues({
    journalEntries: [{ idx: 31, tag: "0031_auth_failed_integration_columns" }],
    existingSnapshotFilenames: [],
    stagedSqlBasenames: [],
    stagedSnapshotBasenames: [],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /0031_snapshot\.json/);
});

test("ignores non-snapshot files in the meta directory", () => {
  const issues = findSnapshotIssues({
    journalEntries: [{ idx: 0, tag: "0000_init" }],
    existingSnapshotFilenames: ["0000_snapshot.json", "_journal.json", "README.md"],
    stagedSqlBasenames: [],
    stagedSnapshotBasenames: [],
  });
  assert.deepEqual(issues, []);
});

test("empty journal produces no issues", () => {
  const issues = findSnapshotIssues({
    journalEntries: [],
    existingSnapshotFilenames: [],
    stagedSqlBasenames: [],
    stagedSnapshotBasenames: [],
  });
  assert.deepEqual(issues, []);
});

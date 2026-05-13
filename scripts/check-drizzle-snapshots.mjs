#!/usr/bin/env node
/**
 * Pre-commit + CI guard: verify the drizzle migration / snapshot pair stays
 * consistent.
 *
 * Two checks (see `scripts/lib/check-drizzle-snapshots.mjs` for the pure rule
 * and TDD coverage):
 *
 *  1. Every entry in `_journal.json` has a matching `NNNN_snapshot.json`.
 *  2. If a new migration .sql is staged for THIS commit, its companion
 *     snapshot must also be staged.
 *
 * Run from the repo root. Exits non-zero with a human-readable explanation
 * when any rule is broken.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findSnapshotIssues } from "./lib/check-drizzle-snapshots.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metaDir = join(repoRoot, "packages/web/drizzle/meta");
const migrationsDir = join(repoRoot, "packages/web/drizzle");
const journalPath = join(metaDir, "_journal.json");

if (!existsSync(journalPath)) {
  // Migration tooling not initialized — nothing to guard. (Happens in early
  // clones before `pnpm db:generate` has ever run.)
  process.exit(0);
}

const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const journalEntries = journal.entries ?? [];
const existingSnapshotFilenames = readdirSync(metaDir);

function gitDiffCached(args) {
  try {
    const out = execSync(`git diff --cached --name-only ${args}`, {
      encoding: "utf8",
      cwd: repoRoot,
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const stagedNewFiles = gitDiffCached("--diff-filter=A");
const stagedAnyChange = gitDiffCached("");

const sqlPathPrefix = "packages/web/drizzle/";
const snapshotPathPrefix = "packages/web/drizzle/meta/";

const stagedSqlBasenames = stagedNewFiles
  .filter((p) => p.startsWith(sqlPathPrefix) && /\/\d{4}_.*\.sql$/.test(p))
  .map((p) => p.slice(sqlPathPrefix.length));

const stagedSnapshotBasenames = stagedAnyChange
  .filter((p) => p.startsWith(snapshotPathPrefix) && /\/\d{4}_snapshot\.json$/.test(p))
  .map((p) => p.slice(snapshotPathPrefix.length));

const issues = findSnapshotIssues({
  journalEntries,
  existingSnapshotFilenames,
  stagedSqlBasenames,
  stagedSnapshotBasenames,
});

if (issues.length === 0) {
  process.exit(0);
}

console.error("❌ Drizzle snapshot integrity check failed:\n");
for (const issue of issues) {
  console.error(`  • ${issue}\n`);
}
console.error(
  `(See docs at https://docs.heypinchy.com/contribute/drizzle-migrations/ for the snapshot recovery runbook.)\n`
);
console.error(
  `(Migrations dir: ${migrationsDir.replace(repoRoot + "/", "")})`
);
process.exit(1);

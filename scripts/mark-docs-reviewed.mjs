#!/usr/bin/env node
/**
 * Records that the docs have been read against this branch's changes — the
 * last step of the `review-docs` skill, and what lets the PR hook stand aside.
 *
 * The marker holds the HEAD sha and lives in the git directory, so it is
 * untracked, per-worktree, and self-invalidating: land another commit and the
 * recorded sha no longer matches, so the review stops counting. That is the
 * point — a review of three commits ago is not a review of this branch.
 *
 * `git rev-parse --git-path` rather than a literal `.git/…`: inside a worktree
 * `.git` is a FILE pointing elsewhere, and writing through it would fail (or,
 * worse, land in the wrong place).
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const headSha = git(["rev-parse", "HEAD"]);
const markerPath = git(["rev-parse", "--git-path", "pinchy-docs-review"]);

writeFileSync(markerPath, `${headSha}\n`);

process.stdout.write(
  `✓ docs review recorded for ${headSha.slice(0, 12)}\n` +
    `  (a further commit invalidates it — re-run after you change anything)\n`,
);

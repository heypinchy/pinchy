#!/usr/bin/env node
/**
 * Test-removal guard (CI).
 *
 * Fails when a pull request removes automated tests on net, unless the removal
 * is explicitly authorized. This closes the gap left by the no-untracked-skips
 * guard: that guard catches `.skip`/`.todo`, but outright DELETION of a test
 * file or an `it()`/`test()` block leaves nothing to match. A real regression
 * shipped exactly this way (PR that deleted two composer composition tests),
 * so deletion must be a conscious, tracked act — same philosophy as skips.
 *
 * Usage:
 *   node scripts/check-test-deletions.mjs [--base <ref>]
 *
 * Base ref resolution: --base arg > $BASE_REF env > "origin/main".
 *
 * Override (either is sufficient):
 *   - Apply the `allow-test-deletion` PR label (CI passes $ALLOW_TEST_DELETION).
 *   - Add a commit trailer referencing an issue:
 *       Allow-test-deletion: #1234
 *
 * See AGENTS.md § "No Untracked Test Removal".
 */

import { execFileSync } from "node:child_process";
import {
  TEST_FILE_RE,
  analyzeChanges,
  parseOverride,
  diffArgs,
} from "./lib/check-test-deletions.mjs";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitSafe(args) {
  // For `git show <ref>:<path>` where the path may not exist at that ref.
  try {
    return git(args);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  let base = process.env.BASE_REF || "origin/main";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
  }
  return { base };
}

function isTestPath(path) {
  return TEST_FILE_RE.test(path);
}

/**
 * Parse `git diff --name-status -M` into changed test-file descriptors.
 * Returns [{ path, status, oldPath }] for test files only.
 */
function parseNameStatus(raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0];
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (isTestPath(newPath) || isTestPath(oldPath)) {
        out.push({ path: newPath, oldPath, status: "renamed" });
      }
      continue;
    }
    const path = parts[1];
    if (!isTestPath(path)) continue;
    if (code === "A") out.push({ path, status: "added" });
    else if (code === "D") out.push({ path, status: "deleted" });
    else out.push({ path, status: "modified" }); // M, T, etc.
  }
  return out;
}

function main() {
  const { base } = parseArgs(process.argv.slice(2));

  if (!gitSafe(["rev-parse", "--verify", base])) {
    console.error(
      `[test-removal-guard] base ref "${base}" not found. In CI, fetch it first ` +
        `(git fetch --no-tags --depth=200 origin <base>). Skipping guard.`,
    );
    process.exit(0);
  }

  // Best-effort merge-base for correct PR-diff semantics; tip-to-tip fallback
  // keeps the guard working in a shallow clone with no common ancestor.
  const mergeBase = gitSafe(["merge-base", base, "HEAD"]);
  const changedRaw = gitSafe(diffArgs(mergeBase, base));
  if (changedRaw === null) {
    // Could not compute a diff at all (unexpected). Fail open with a loud
    // warning rather than blocking every PR on a guard-infrastructure error.
    console.error(
      `[test-removal-guard] could not compute a diff against "${base}" — skipping guard. ` +
        `Check the CI checkout/fetch depth.`,
    );
    process.exit(0);
  }
  const changed = parseNameStatus(changedRaw);

  if (changed.length === 0) {
    console.log("[test-removal-guard] no test files changed — OK");
    process.exit(0);
  }

  const files = changed.map((c) => {
    const oldPath = c.status === "renamed" ? c.oldPath : c.path;
    const before =
      c.status === "added" ? null : gitSafe(["show", `${base}:${oldPath}`]);
    const after =
      c.status === "deleted" ? null : gitSafe(["show", `HEAD:${c.path}`]);
    return { path: c.path, status: c.status, before, after };
  });

  const { netRemoved, removals } = analyzeChanges(files);

  if (netRemoved === 0) {
    console.log(
      `[test-removal-guard] ${changed.length} test file(s) changed, no net test removal — OK`,
    );
    process.exit(0);
  }

  const messages = (
    gitSafe(["log", "--format=%B", `${base}..HEAD`]) || ""
  ).split(/\n(?=commit |$)/);
  const override = parseOverride({
    envValue: process.env.ALLOW_TEST_DELETION,
    messages: [messages.join("\n"), process.env.PR_BODY || ""],
  });

  const detail = removals
    .map(
      (r) =>
        `  - ${r.path}: ${r.before} → ${r.after} test case(s) (${r.delta})`,
    )
    .join("\n");

  if (override.allowed) {
    console.log(
      `[test-removal-guard] net removal of ${netRemoved} test case(s), allowed via ${override.reason}:\n${detail}`,
    );
    process.exit(0);
  }

  console.error(
    `[test-removal-guard] This PR removes ${netRemoved} test case(s) on net:\n${detail}\n\n` +
      `Removing tests must be a deliberate, tracked act. If this is intentional ` +
      `(e.g. dead-code cleanup, a deduplicated test, a feature removal):\n` +
      `  • file/locate the tracking issue, then add a commit trailer:\n` +
      `        Allow-test-deletion: #<issue-number>\n` +
      `    (amend the commit or add an empty commit with the trailer), OR\n` +
      `  • apply the "allow-test-deletion" label to the PR.\n` +
      `Otherwise, restore the tests. See AGENTS.md § "No Untracked Test Removal".`,
  );
  process.exit(1);
}

main();

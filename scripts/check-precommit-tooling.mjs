#!/usr/bin/env node
/**
 * Pre-commit preflight: fail with an instruction, not with an ENOENT.
 *
 * lint-staged's whole-tree rule runs on every commit, so its binary must be
 * installed on every commit. When it is not — a node_modules older than the
 * package.json that added it — lint-staged dies with a bare "command not found"
 * that names no fix, and the committer reaches for `--no-verify`, which also
 * skips the drizzle-snapshot check and the absolute-path guard in this same
 * hook (#838). Checking first turns that into one actionable line.
 *
 * See scripts/lib/precommit-tooling.mjs for the reasoning; the guard tests live
 * in scripts/lib/precommit-tooling.test.mjs (`pnpm test:scripts`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  allToolingRequirements,
  binDirsFor,
  formatMissingToolingMessage,
  requiredBinaries,
  resolveBinary,
} from "./lib/precommit-tooling.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);
const lintStaged = packageJson["lint-staged"];

// Resolve from the repo root of THIS checkout, which is where lint-staged runs.
// In a git worktree that has no node_modules of its own, the ancestor walk
// reaches the main checkout's — the same path lint-staged's PATH takes.
const missing = requiredBinaries(lintStaged).filter(
  (binary) => resolveBinary(binary, binDirsFor(repoRoot)) === null,
);

if (process.argv.includes("--explain")) {
  // Post-mortem for a lint-staged run that already failed. The rules scoped to a
  // package can only be judged here: whether they run at all depends on what is
  // staged, so blocking on them up front would reject a docs commit over a
  // binary it never invokes. Never exits non-zero — the hook owns the status,
  // and a silent run means the failure was a real lint error.
  const unresolvable = allToolingRequirements(lintStaged)
    .filter(
      ({ binary, dir }) =>
        resolveBinary(binary, binDirsFor(resolve(repoRoot, dir))) === null,
    )
    .map(({ binary, dir }) => (dir === "." ? binary : `${binary} (${dir})`));
  if (unresolvable.length > 0) {
    console.error("");
    console.error(formatMissingToolingMessage(unresolvable));
  }
  process.exit(0);
}

if (missing.length > 0) {
  console.error(formatMissingToolingMessage(missing));
  process.exit(1);
}

#!/usr/bin/env node
/**
 * `pnpm test:related` — runs only the tests that transitively import what you
 * changed, with no arguments required.
 *
 * See lib/test-related.mjs for why the no-arguments part is the whole point: the
 * documented `pnpm -C packages/web test:related <files>` asks you to know and
 * type your own change set at the moment you want a fast answer, and `pnpm test`
 * asks for nothing — so the expensive habit wins by default.
 *
 * This is an inner-loop check, NOT a verification gate. It cannot see a test
 * that reaches your change through a mock, a string-keyed lookup, or a drift
 * guard that reads the file from disk. Run the full suite before you push.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { toVitestPaths } from "./lib/test-related.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = join(REPO_ROOT, "packages", "web");

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Everything the working tree changes against HEAD, tracked and untracked.
 *
 * -z throughout: without it git C-quotes any path outside ASCII
 * ("packages/web/src/f\303\274r.ts", quotes included), and such a path then
 * matches no prefix rule and is silently dropped — the tests for a file with an
 * umlaut in its name would quietly never run.
 */
function changedFiles() {
  const tracked = git(["diff", "--name-only", "-z", "HEAD"]).split("\0");
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]).split("\0");
  return [...tracked, ...untracked];
}

const explicit = process.argv.slice(2);
let candidates;
try {
  candidates = explicit.length > 0 ? explicit : changedFiles();
} catch (err) {
  console.error(`test:related: could not read the change set (${err.message})`);
  process.exit(1);
}

const paths = toVitestPaths(candidates, {
  exists: (p) => existsSync(join(WEB_DIR, p)),
});

if (paths.length === 0) {
  console.error(
    explicit.length > 0
      ? "test:related: none of those paths have tests in the web runner (docs, root scripts and CI config have none)."
      : "test:related: nothing changed that the web runner covers. Name files explicitly, or run `pnpm test` for the full suite.",
  );
  process.exit(0);
}

console.error(
  `ℹ test:related: ${paths.length} changed file(s) — running the tests that import them.\n` +
    `  This is an inner-loop check, not a gate: run the full suite before pushing.\n`,
);

// Inherit stdio so vitest's own reporter is untouched, and pass its exit code
// straight through — an inner-loop check that cannot go red is worthless.
const { status } = spawnSync(
  "pnpm",
  ["exec", "vitest", "related", "--run", ...paths],
  { cwd: WEB_DIR, stdio: "inherit" },
);
process.exit(status ?? 1);

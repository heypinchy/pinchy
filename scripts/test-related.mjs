#!/usr/bin/env node
/**
 * `pnpm test:related` — runs only the tests that transitively import what you
 * changed, with no arguments required.
 *
 * See lib/test-related.mjs for why the no-arguments part is the whole point:
 * `vitest related <files>` asks you to know and type your own change set at the
 * moment you want a fast answer, and `pnpm test` asks for nothing — so the
 * expensive habit wins by default. The change set covers this branch's commits as
 * well as the working tree, so it does not empty out the moment you commit.
 *
 * This is an inner-loop check, NOT a verification gate. It cannot see a test
 * that reaches your change through a mock, a string-keyed lookup, or a drift
 * guard that reads the file from disk. Run the full suite before you push.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { toVitestPaths, collectChangedFiles } from "./lib/test-related.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = join(REPO_ROOT, "packages", "web");

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const explicit = process.argv.slice(2);
let candidates;
try {
  candidates = explicit.length > 0 ? explicit : collectChangedFiles(git);
} catch (err) {
  console.error(`test:related: could not read the change set (${err.message})`);
  process.exit(1);
}

const paths = toVitestPaths(candidates, {
  exists: (p) => existsSync(join(WEB_DIR, p)),
});

if (paths.length === 0) {
  // The two ways of running no tests are not the same result, and the exit code
  // is the only place that difference reaches a shell.
  //
  // No arguments: the change set holds nothing this runner covers — a docs-only
  // branch. Nothing ran and nothing should have, so this is a pass.
  //
  // Arguments: the caller ASSERTED those files, and none of them survived. A
  // typo, a path that is gone, a shape the translation drops — all of them mean
  // the request went unanswered, and reporting success for it is exactly the
  // silent miss this tool exists to prevent (see lib/test-related.mjs). Name
  // the paths, too: "none of those" leaves a typo indistinguishable from a file
  // that genuinely has no tests here.
  if (explicit.length > 0) {
    console.error(
      `test:related: no tests to run for ${explicit.join(", ")}.\n` +
        `  A path is dropped when it does not exist, is not a module vitest can trace,\n` +
        `  or lives outside the web runner (docs/, root scripts/, .github/).`,
    );
    process.exit(1);
  }
  console.error(
    "test:related: nothing changed that the web runner covers. Name files explicitly, or run `pnpm test` for the full suite.",
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

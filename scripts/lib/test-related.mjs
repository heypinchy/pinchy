/**
 * Turns a list of changed files into the arguments `vitest related` expects.
 *
 * WHY THIS EXISTS. `vitest related <files>` is the cheap inner loop and nobody
 * reaches for it, and the reason is not that people disagree with it: it asks you
 * to know AND type which files you touched, at the exact moment you want a quick
 * answer. `pnpm test` asks for nothing. So the expensive habit wins by default,
 * and the machine pays — see lib/test-lock.mjs for what a full suite actually
 * costs when several sessions do that at once.
 *
 * This module removes the typing. `pnpm test:related` with no arguments takes the
 * change set from git; arguments still win when you want a specific file.
 *
 * The translation itself is the other half. `vitest related` resolves paths
 * against the vitest root (packages/web), while git reports them relative to the
 * REPO root — hand git's output straight through and vitest matches nothing and
 * says "no test files found", which reads like "nothing to run" rather than
 * "wrong path shape". That silent miss is worse than an error, because it looks
 * exactly like a pass.
 */

const WEB_PREFIX = "packages/web/";
const PLUGINS_PREFIX = "packages/plugins/";

/**
 * The web-relative forms we accept from someone who ran this from inside
 * packages/web. Pinned to the directories the web vitest config actually
 * includes (`src/**`, `eval/**`, `../plugins/**`) rather than to "anything that
 * is not obviously elsewhere" — `scripts/` in particular exists BOTH at the repo
 * root and under packages/web, and guessing wrong there means either dropping a
 * real target or feeding vitest a path it cannot resolve.
 */
const WEB_RELATIVE_ROOTS = ["src/", "eval/", "../plugins/"];

/**
 * `vitest related` traces the module graph, so only files that can BE a module
 * are useful arguments. A changed package.json, migration or asset lives under
 * packages/web and really exists — nothing else in this module rejects it — and
 * vitest then reports "no test files found" and exits non-zero, turning a run
 * that had real targets into a spurious red.
 */
const TRACEABLE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * @param {string[]} paths repo-relative (or already web-relative) file paths
 * @param {{exists?: (path: string) => boolean}} [opts] `exists` is injected so
 *   the caller can drop deleted files — vitest errors on a path that is gone,
 *   which would cost the run the files that DO still exist.
 * @returns {string[]} paths relative to packages/web, deduped, order preserved
 */
export function toVitestPaths(paths, opts = {}) {
  const exists = opts.exists ?? (() => true);
  const out = [];
  const seen = new Set();

  for (const raw of paths) {
    const path = raw.trim();
    if (!path || !TRACEABLE.test(path)) continue;

    let translated = null;
    if (path.startsWith(WEB_PREFIX)) {
      translated = path.slice(WEB_PREFIX.length);
    } else if (path.startsWith(PLUGINS_PREFIX)) {
      // The web vitest config includes ../plugins/pinchy-*, so these are real
      // test targets in this runner rather than a separate suite.
      translated = `../plugins/${path.slice(PLUGINS_PREFIX.length)}`;
    } else if (WEB_RELATIVE_ROOTS.some((root) => path.startsWith(root))) {
      // Already web-relative — someone ran this from inside packages/web.
      translated = path;
    }
    // Everything else — docs/, root scripts/, .github/, compose files, a bare
    // AGENTS.md — has no tests in this runner at all. Dropping it here is the
    // point: passed through, it becomes a vitest miss that reads like a pass.
    if (translated === null) continue;

    // A file that no longer exists cannot be imported by anything, and vitest
    // errors on it rather than skipping it.
    if (!exists(translated)) continue;
    if (seen.has(translated)) continue;
    seen.add(translated);
    out.push(translated);
  }
  return out;
}

/**
 * Everything this branch changes: the working tree AND the commits on it.
 *
 * The working tree alone is the obvious answer and the wrong one. `git diff HEAD`
 * goes empty the moment you commit, so the tool would report "nothing changed"
 * and exit 0 on a branch full of work — a zero-test run that reads exactly like a
 * pass, arriving precisely when you are trying to check a commit before pushing.
 * The union is what a reader means by "what I changed".
 *
 * @param {(args: string[]) => string} git runs git and returns its stdout
 * @param {{baseRef?: string}} [opts] what this branch is measured against
 * @returns {string[]} repo-relative paths, possibly with duplicates and blanks —
 *   `toVitestPaths` is the one place that normalizes both.
 *
 * -z throughout: without it git C-quotes any path outside ASCII
 * ("packages/web/src/f\303\274r.ts", quotes included), and such a path then
 * matches no prefix rule and is silently dropped — the tests for a file with an
 * umlaut in its name would quietly never run.
 */
export function collectChangedFiles(git, opts = {}) {
  const baseRef = opts.baseRef ?? "origin/main";

  // Not wrapped: a git that cannot answer this at all is worth reporting to the
  // user, not papering over. The branch range below is the optional half.
  const files = [
    ...git(["diff", "--name-only", "-z", "HEAD"]).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ];

  try {
    // The merge base, not the ref itself: diffing against a moved origin/main
    // would report every file anyone else changed since you branched.
    const base = git(["merge-base", baseRef, "HEAD"]).trim();
    // An empty base is not an error but it is not a revision either, and passing
    // "" to git diff means something else entirely.
    if (base) {
      files.push(
        ...git(["diff", "--name-only", "-z", base, "HEAD"]).split("\0"),
      );
    }
  } catch {
    // No base ref — a fresh clone with no remote, a shallow checkout, a branch
    // taken from something other than main. Fail open, like the test lock: half
    // a change set still runs useful tests, where refusing to run any is the
    // outcome that sends the reader back to the full suite.
  }

  return files;
}

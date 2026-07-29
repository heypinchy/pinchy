/**
 * Turns a list of changed files into the arguments `vitest related` expects.
 *
 * WHY THIS EXISTS. `pnpm -C packages/web test:related <files>` has been the
 * documented inner loop for a while and is barely used, and the reason is not
 * that people disagree with it: it asks you to know AND type which files you
 * touched, at the exact moment you want a quick answer. `pnpm test` asks for
 * nothing. So the cheap habit wins, and the machine pays — see lib/test-lock.mjs
 * for what a full suite actually costs when several sessions do that at once.
 *
 * This module removes the typing. `pnpm test:related` with no arguments takes
 * the working tree's own change set from git; arguments still win when you want
 * a specific file.
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
const WEB_RELATIVE_ROOTS = ["src/", "eval/"];

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

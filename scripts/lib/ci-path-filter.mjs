/**
 * Decides whether a set of changed files justifies CI's expensive job matrix.
 *
 * This replaces the `paths-ignore:` that ci.yml used to carry. That filter
 * worked at the WORKFLOW level, which is exactly why it had to go: ci.yml hosts
 * main's required status checks, and a workflow that never starts never reports
 * a status — so a docs-only PR sat forever on "Expected — Waiting for status to
 * be reported" and could not be merged, with nothing actually broken.
 *
 * The fix keeps the workflow always starting, and moves the same path filter
 * down to the JOB level:
 *   - the required checks (ALWAYS_RUN_JOBS) run on every PR and always report;
 *   - every other job is gated on the `changes` job and is simply skipped when
 *     only docs changed, which is where the CI-minute saving actually came from.
 *
 * The drift guards in ci-path-filter.test.mjs keep that wiring honest.
 */

/**
 * Paths that never need the Docker/E2E matrix, as predicates rather than globs
 * — the set is small and fixed, so a glob engine would be more machinery than
 * the job needs. Each mirrors the glob ci.yml used to ignore.
 *
 * `PERSONALITY.md` is covered by the `**\/*.md` rule and needs no entry.
 */
const IGNORED_PATHS = [
  { glob: "docs/**", matches: (p) => p.startsWith("docs/") },
  { glob: "**/*.md", matches: (p) => p.endsWith(".md") },
  {
    glob: ".github/ISSUE_TEMPLATE/**",
    matches: (p) => p.startsWith(".github/ISSUE_TEMPLATE/"),
  },
  { glob: "sample-data/**", matches: (p) => p.startsWith("sample-data/") },
  { glob: "screenshots/**", matches: (p) => p.startsWith("screenshots/") },
];

/** ci.yml jobs that must run on every PR because branch protection requires them. */
export const ALWAYS_RUN_JOBS = ["quality", "vitest-integration", "e2e"];

/** The `if:` condition every other ci.yml job must carry. */
export const GATE_EXPRESSION = "needs.changes.outputs.code == 'true'";

/**
 * @param {string} path repo-relative path of a changed file
 * @returns {boolean} true when the path cannot affect build/test outcomes
 */
export function isIgnoredPath(path) {
  return IGNORED_PATHS.some((rule) => rule.matches(path));
}

/**
 * @param {string[]} paths repo-relative paths of every changed file
 * @returns {boolean} true when the expensive job matrix must run
 */
export function hasCodeChanges(paths) {
  const changed = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  // An empty list means we could not determine what changed (shallow clone,
  // force push, unresolvable base) — not that nothing did. Run everything:
  // wasting CI minutes is recoverable, skipping the matrix on a real code
  // change is not.
  if (changed.length === 0) return true;
  return changed.some((p) => !isIgnoredPath(p));
}

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
 *   - the UNGATED_JOBS run on every PR and always report;
 *   - every other job is gated on the `changes` job and is simply skipped when
 *     only docs changed, which is where the CI-minute saving actually came from.
 *
 * The drift guards in ci-path-filter.test.mjs keep that wiring honest.
 */

/**
 * docs/ is prose — except its dependency manifest. vuln-scan explicitly scans
 * `./docs/pnpm-lock.yaml`, so treating a docs-lockfile security bump as
 * "docs-only" would skip the very scan that proves the fix, and main would stay
 * red until someone hand-ran workflow_dispatch. The lockfile guard in the test
 * pins this to vuln-scan's real arguments rather than to this comment.
 */
const DOCS_LOCKFILE = "docs/pnpm-lock.yaml";

/**
 * Paths that never need the Docker/E2E matrix, as predicates rather than globs
 * — the set is small and fixed, so a glob engine would be more machinery than
 * the job needs. Each mirrors the glob ci.yml used to ignore.
 *
 * `PERSONALITY.md` is covered by the `**\/*.md` rule and needs no entry.
 */
const IGNORED_PATHS = [
  { glob: "docs/**", matches: (p) => p.startsWith("docs/") && p !== DOCS_LOCKFILE },
  { glob: "**/*.md", matches: (p) => p.endsWith(".md") },
  {
    glob: ".github/ISSUE_TEMPLATE/**",
    matches: (p) => p.startsWith(".github/ISSUE_TEMPLATE/"),
  },
  { glob: "sample-data/**", matches: (p) => p.startsWith("sample-data/") },
  { glob: "screenshots/**", matches: (p) => p.startsWith("screenshots/") },
];

/**
 * ci.yml jobs that deliberately carry no `changes` gate, and why. The two
 * reasons are distinct, and an earlier single "always run" list conflated them:
 *
 *   - `required` — named in main's branch protection. A required check must
 *     report on EVERY pull request, so gating it would rest main's protection on
 *     GitHub's subtle "a skipped job counts as success" behaviour.
 *   - `docs-relevant` — cheap, and guards exactly the files a docs-only PR
 *     changes. `links` checks `**\/*.md`, so gating it would skip the link check
 *     on precisely the PRs that edit links.
 */
export const UNGATED_JOBS = {
  quality: "required",
  "vitest-integration": "required",
  e2e: "required",
  links: "docs-relevant",
};

/** The UNGATED_JOBS subset that branch protection requires. */
export const REQUIRED_JOBS = Object.entries(UNGATED_JOBS)
  .filter(([, reason]) => reason === "required")
  .map(([name]) => name);

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

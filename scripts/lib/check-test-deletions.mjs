/**
 * Pure logic for the test-removal guard (see scripts/check-test-deletions.mjs
 * for the CLI/CI wrapper and AGENTS.md § "No Untracked Test Removal").
 *
 * The guard is a tripwire, not a precise metric: it counts test-case
 * invocations with a regex and fails CI when a PR removes tests on net,
 * unless an explicit, tracked override is present. Mirrors the philosophy of
 * the no-untracked-skips guard — deletion must be a conscious, greppable act.
 */

// Same matcher the no-untracked-skips drift-guard uses, kept in sync on purpose.
export const TEST_FILE_RE = /\.(test|spec)\.(?:c|m)?[jt]sx?$/;

// Match test *cases* — it / test / xit / fit, including modifier chains
// (.skip/.only/.todo/.each/...) — terminated by "(" or a "`" (for
// `it.each`table``). `describe` is intentionally excluded: it is a group, not
// a case (removing a describe still removes the it()s inside it, which are
// counted). The leading look-behind rejects keywords embedded in identifiers
// (commit, submit, latest, audit) and method calls (obj.it(...)).
const TEST_CASE_RE =
  /(?<![\w$.])(?:it|test|xit|fit)(?:\.(?:skip|only|todo|fails|failing|concurrent|sequential|each|runIf|skipIf))*\s*[(`]/g;

/**
 * Count test cases in a source string.
 * @param {string} source
 * @returns {number}
 */
export function countTestCases(source) {
  if (!source) return 0;
  const matches = source.match(TEST_CASE_RE);
  return matches ? matches.length : 0;
}

/**
 * Analyze a set of changed test files.
 * @param {Array<{path: string, status: string, before: string|null, after: string|null}>} files
 * @returns {{ netRemoved: number, removals: Array<{path: string, before: number, after: number, delta: number}> }}
 */
export function analyzeChanges(files) {
  let totalBefore = 0;
  let totalAfter = 0;
  const removals = [];

  for (const file of files) {
    const before = file.before == null ? 0 : countTestCases(file.before);
    const after = file.after == null ? 0 : countTestCases(file.after);
    totalBefore += before;
    totalAfter += after;
    if (after < before) {
      removals.push({ path: file.path, before, after, delta: after - before });
    }
  }

  removals.sort((a, b) => a.delta - b.delta);
  return { netRemoved: Math.max(0, totalBefore - totalAfter), removals };
}

// An override must be a deliberate, tracked act — either a maintainer applied
// the PR label (passed in via env) or a commit trailer references an issue.
// A bare "Allow-test-deletion: because reasons" is rejected, mirroring the
// no-untracked-skips contract where "tracked separately" is not tracking.
const ISSUE_REF_RE =
  /#\d+|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/;
const TRAILER_RE = /Allow-test-deletion:\s*(.+)/i;

/**
 * Decide whether removing tests is explicitly authorized.
 * @param {{ envValue?: string, messages?: string[] }} input
 * @returns {{ allowed: boolean, reason: string }}
 */
export function parseOverride({ envValue, messages = [] } = {}) {
  const env = (envValue ?? "").trim().toLowerCase();
  if (env === "true" || env === "1" || env === "yes") {
    return { allowed: true, reason: "allow-test-deletion label" };
  }
  for (const message of messages) {
    const match = message.match(TRAILER_RE);
    if (match && ISSUE_REF_RE.test(match[1])) {
      const ref = match[1].match(ISSUE_REF_RE)[0];
      return { allowed: true, reason: `Allow-test-deletion trailer (${ref})` };
    }
  }
  return { allowed: false, reason: "" };
}

/**
 * Build the `git diff` argument list for the PR's changed test files.
 *
 * Prefers a two-dot range from the merge-base (`<merge-base>..HEAD`), which is
 * the correct "changes introduced by this branch" semantics. Falls back to a
 * tip-to-tip two-dot range (`<base> HEAD`) when no merge-base is known — e.g. a
 * shallow CI checkout with no common ancestor. We deliberately never use the
 * three-dot form (`<base>...HEAD`): it requires a merge-base and throws in a
 * shallow clone, which is exactly what crashed the guard.
 *
 * @param {string|null|undefined} mergeBase
 * @param {string} base
 * @returns {string[]}
 */
export function diffArgs(mergeBase, base) {
  const head = ["diff", "--name-status", "-M"];
  if (mergeBase && mergeBase.trim()) {
    return [...head, `${mergeBase.trim()}..HEAD`];
  }
  return [...head, base, "HEAD"];
}

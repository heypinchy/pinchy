/**
 * Pure logic for the docs-review hook (see scripts/hooks/require-docs-review.mjs
 * for the Claude Code `PreToolUse` wrapper and AGENTS.md § "Some Docs Checks
 * Can Only Be Read, Not Run").
 *
 * The `review-docs` skill was, on arrival, exactly the thing this repo keeps
 * getting burned by: an instruction in AGENTS.md with nothing behind it.
 * "Update docs in the same PR" sat there for a year and the v0.9.0 cycle
 * shipped three feature families undocumented; there is no reason "run the
 * review skill before opening a PR" would fare better.
 *
 * So the skill gets a trigger. The hook fires on `gh pr create`, works out
 * whether this branch moved anything a reader can see, and refuses the PR
 * until the review has happened — or until somebody says, in the commit
 * history, why it doesn't need to.
 *
 * The marker is keyed to the HEAD sha on purpose: push three more commits
 * after a review and the review no longer covers them, so it stops counting.
 * It is not a security boundary, and nothing here pretends otherwise — an
 * agent could write the marker without reading a line, exactly as a human can
 * `git push --no-verify`. The job is to make FORGETTING impossible, which is
 * the failure mode that actually occurs.
 */

/** Matches `gh pr create`, including inside a compound command. */
const PR_CREATE_RE = /(^|[;&|]\s*)gh\s+pr\s+create\b/;

/** `--base <ref>` / `-B <ref>`, the branch the PR would target. */
const BASE_FLAG_RE = /(?:--base|-B)[=\s]+["']?([^\s"']+)/;

/**
 * @param {string} command the Bash tool's `command` input
 * @returns {boolean}
 */
export function isPrCreateCommand(command) {
  return PR_CREATE_RE.test(command ?? "");
}

/**
 * The base branch as written on the command line, verbatim.
 *
 * Deliberately no `origin/` guesswork here. `gh pr create --base main` names a
 * branch that may not be checked out locally, so `origin/main` is the better
 * ref to diff against — but `--base v0.8.0` names a tag, where `origin/v0.8.0`
 * does not exist at all. Guessing got that wrong; `candidateBaseRefs` below
 * hands the caller both spellings in the order worth trying, and git decides.
 *
 * @param {string} command
 * @param {string} [fallback]
 * @returns {string}
 */
export function parseBaseRef(command, fallback = "main") {
  const match = BASE_FLAG_RE.exec(command ?? "");
  return match ? match[1] : fallback;
}

/**
 * Spellings of a base ref to try, most-likely first.
 *
 * @param {string} ref
 * @returns {string[]}
 */
export function candidateBaseRefs(ref) {
  if (ref.startsWith("origin/")) return [ref];
  return [`origin/${ref}`, ref];
}

/**
 * @param {object} input
 * @param {Array<{path: string, what: string, docs: string}>} input.surfaces
 *   user-visible surfaces this branch touches (from docs-required.mjs)
 * @param {string} input.headSha
 * @param {string|null} input.markedSha contents of the review marker, if any
 * @param {{allowed: boolean, reason: string}} input.override
 * @returns {{allow: true} | {allow: false, reason: string}}
 */
export function decideDocsReview({ surfaces, headSha, markedSha, override }) {
  if (surfaces.length === 0) return { allow: true };
  if (override?.allowed) return { allow: true };
  if (markedSha && markedSha.trim() === headSha.trim()) return { allow: true };

  const staleReview =
    markedSha && markedSha.trim() !== headSha.trim()
      ? "\n\nA review was recorded for an earlier commit; commits have landed since, so it no longer covers this branch."
      : "";

  const list = surfaces
    .slice(0, 8)
    .map((s) => `  - ${s.path} (${s.what})`)
    .join("\n");
  const more =
    surfaces.length > 8 ? `\n  …and ${surfaces.length - 8} more` : "";

  return {
    allow: false,
    reason:
      "This branch changes a user-visible surface, so the docs need a reading pass " +
      "before the PR opens — the CI guards check that identifiers are documented, " +
      "not that the prose is still true.\n\n" +
      `${list}${more}${staleReview}\n\n` +
      "Run the `review-docs` skill, act on what it finds, then record it:\n" +
      "  node scripts/mark-docs-reviewed.mjs\n\n" +
      "If the docs genuinely don't move, say why in a commit trailer instead:\n" +
      "  Docs-not-needed: <what makes this invisible to a reader>",
  };
}

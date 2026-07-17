/**
 * Two invariants that only exist because ci.yml shards jobs, and that nothing in
 * GitHub Actions would ever complain about.
 *
 * Both fail SILENTLY, which is why they are guards and not comments:
 *
 *  1. A `strategy.matrix` renames a job's status check — `E2E Tests` becomes
 *     `E2E Tests (1/2)`. Branch protection matches checks by NAME, so sharding a
 *     required job leaves main waiting forever on a name that will never report
 *     again: unmergeable, with nothing actually broken. Same failure as the
 *     workflow-level `paths-ignore` ci-path-filter.mjs exists to prevent,
 *     reached from the other direction.
 *
 *  2. A shard's denominator is written twice — `shard: [1, 2]` and
 *     `--shard=${{ matrix.shard }}/2`. Raise the denominator to 3 and forget the
 *     matrix list, and shard 3's third of the suite never runs while both jobs
 *     stay green. That is exactly the "a test silently stops protecting you"
 *     failure the no-untracked-skips and check-test-deletions guards exist for,
 *     arriving through a door neither one watches. (The inverse — `[1,2,3]` with
 *     `/2` — fails loudly on its own, so only this direction needs a guard.)
 *
 * Textual sweeps, dependency-free, matching the other workflow guards here.
 */

import { splitWorkflowIntoJobs } from "./workflow-jobs.mjs";

/**
 * Job names that carry a `strategy.matrix`.
 *
 * @param {string} workflowPath absolute path to a workflow file
 * @returns {string[]}
 */
export function shardedJobs(workflowPath) {
  return splitWorkflowIntoJobs(workflowPath)
    .filter((job) => /^\s+strategy:\s*$/m.test(job.body) && /^\s+matrix:\s*$/m.test(job.body))
    .map((job) => job.jobName);
}

/**
 * Every job whose `shard:` matrix length disagrees with the `/N` denominator it
 * passes to Playwright.
 *
 * A job with no `--shard=${{ matrix.shard }}/N` at all is skipped: it has no
 * denominator to disagree with (build-images matrixes over images, not shards).
 *
 * A job that HAS one but whose `shard:` list this cannot read THROWS. The
 * denominator regex already requires `${{ matrix.shard }}`, so referencing it
 * without a readable list is not an innocent shape — it is either broken, or
 * written in a form (a YAML block sequence, an `include:`, an anchor) this
 * textual sweep does not understand. Returning "no offenders" for it would let
 * the guard stop guarding the instant someone reformats a matrix, which is the
 * silent-coverage-loss failure the whole function exists to prevent. Refusing
 * to answer is the only honest response to input it cannot check.
 *
 * @param {string} workflowPath absolute path to a workflow file
 * @throws if a job references `matrix.shard` but declares no inline `shard:` list
 * @returns {Array<{ jobName: string, matrixLength: number, denominator: number }>}
 */
export function shardDenominatorMismatches(workflowPath) {
  const offenders = [];

  for (const job of splitWorkflowIntoJobs(workflowPath)) {
    const denominators = [...job.body.matchAll(/--shard=\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)/g)].map(
      (m) => Number(m[1])
    );
    if (denominators.length === 0) continue;

    const list = /^\s+shard:\s*\[([^\]]*)\]\s*$/m.exec(job.body);
    if (!list) {
      throw new Error(
        `"${job.jobName}" passes --shard=\${{ matrix.shard }}/${denominators[0]} but declares no ` +
          `inline \`shard: [...]\` matrix this check can read. Either it is broken, or the matrix ` +
          `was rewritten in a form this textual sweep does not parse (block sequence, include:, ` +
          `anchor). Restore the inline form, or teach shardDenominatorMismatches the new one — ` +
          `do not leave it unreadable, or a wrong denominator silently stops being caught.`
      );
    }

    const matrixLength = list[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;

    // A job passing two different denominators is broken regardless of the
    // matrix, so compare against each rather than just the first.
    for (const denominator of denominators) {
      if (denominator !== matrixLength) {
        offenders.push({ jobName: job.jobName, matrixLength, denominator });
        break;
      }
    }
  }

  return offenders;
}

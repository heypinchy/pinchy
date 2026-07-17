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
 * Only inspects jobs that declare BOTH — a matrix over something other than
 * shards (build-images' image list) has no denominator to agree with, and a
 * `--shard` with no matrix would be a hardcoded single shard, which the
 * length check below would not describe.
 *
 * @param {string} workflowPath absolute path to a workflow file
 * @returns {Array<{ jobName: string, matrixLength: number, denominator: number }>}
 */
export function shardDenominatorMismatches(workflowPath) {
  const offenders = [];

  for (const job of splitWorkflowIntoJobs(workflowPath)) {
    const list = /^\s+shard:\s*\[([^\]]*)\]\s*$/m.exec(job.body);
    const denominators = [...job.body.matchAll(/--shard=\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)/g)].map(
      (m) => Number(m[1])
    );
    if (!list || denominators.length === 0) continue;

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

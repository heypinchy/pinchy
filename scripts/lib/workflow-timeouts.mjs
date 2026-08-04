/**
 * Drift guard for job-level `timeout-minutes` across every GitHub Actions
 * workflow.
 *
 * None of the 21 jobs in ci.yml (nor any job in the other eight workflows)
 * set `timeout-minutes`. GitHub's default is 360 minutes per job, so a hung
 * `docker compose up`, a stuck poll loop, or a wedged `docker compose pull`
 * ties up a runner for six hours instead of failing fast — and everything
 * queued behind it (including a merge-queue run waiting on a required check)
 * is delayed the same six hours. A workflow that never times out fails
 * loudly eventually, just six hours later than it should, on a schedule
 * nobody chose.
 *
 * So the property this guards is not "some job somewhere sets a timeout" —
 * it is that EVERY job does, in EVERY workflow file, including the
 * schedule-only ones (issue-triage, docs-freshness, sbom, prune-ghcr): a
 * cron job with no human watching it is exactly the case where a silent
 * six-hour hang goes unnoticed longest.
 *
 * Read-side sibling of the no-untracked-skips / no-test-deletion /
 * ci-path-filter guards (see AGENTS.md): it turns "somebody forgot" into a
 * loud, specific failure instead of a runner quietly burning its default
 * budget.
 */

/** A job-level `timeout-minutes:` line, at the job's own (4-space) indent —
 * not a step's (8-space or deeper), which is a different setting entirely. */
const TIMEOUT_LINE = /^ {4}timeout-minutes:[ \t]*(\S+)/m;

/**
 * Reads the job-level `timeout-minutes` out of one job's body text (as
 * produced by {@link import("./workflow-jobs.mjs").splitWorkflowIntoJobs}).
 *
 * @param {string} body
 * @returns {{ minutes: number } | { error: string }}
 */
export function readJobTimeout(body) {
  const match = TIMEOUT_LINE.exec(String(body ?? ""));
  if (!match) {
    return { error: "sets no job-level timeout-minutes" };
  }
  const raw = match[1].replace(/#.*$/, "").trim();
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return {
      error: `timeout-minutes is not a positive number (got ${JSON.stringify(raw)})`,
    };
  }
  return { minutes };
}

/**
 * Checks every job in the given set for a sane job-level `timeout-minutes`.
 *
 * @param {Array<{ jobName: string, body: string, path: string }>} jobs
 * @param {object} [options]
 * @param {number} [options.minimumMinutes] floor below which a timeout is
 *   too tight to be a deliberate choice (default 10) — GitHub's own minimum
 *   quantum plus the belief that nothing meaningful in this repo's CI
 *   finishes faster.
 * @returns {string[]} one message per problem; empty means every job passes
 */
export function validateJobTimeouts(jobs, { minimumMinutes = 10 } = {}) {
  if (!Array.isArray(jobs)) return ["no jobs given to check"];
  const problems = [];
  for (const job of jobs) {
    const result = readJobTimeout(job.body);
    if ("error" in result) {
      problems.push(
        `${job.path} job "${job.jobName}" ${result.error}. GitHub's default is 360 minutes, so a hung ` +
          `step ties up a runner for six hours instead of failing fast — add timeout-minutes.`,
      );
      continue;
    }
    if (result.minutes < minimumMinutes) {
      problems.push(
        `${job.path} job "${job.jobName}" sets timeout-minutes: ${result.minutes}, below the ` +
          `${minimumMinutes}-minute floor this guard enforces (a real check in this repo does not ` +
          `finish faster than that, so a lower number is more likely a typo than a deliberate choice).`,
      );
    }
  }
  return problems;
}

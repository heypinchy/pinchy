/**
 * Shared helper for textual sweeps over GitHub Actions workflow files.
 * No side effects beyond reading the given workflow file.
 */

import { readFileSync } from "node:fs";

/**
 * Splits a workflow file into per-job text blocks. Returns
 * { jobName, body, path } objects. Jobs are detected as 2-space-indented
 * top-level keys under the `jobs:` line; a job's body runs from its header up
 * to (but not including) the next sibling job header (or EOF for the last job).
 *
 * Kept deliberately dependency-free (no YAML parser): the textual sweep is
 * precise enough because the assertions only look for literal step tokens.
 *
 * @param {string} workflowPath - absolute path to a .yml/.yaml workflow file
 * @returns {Array<{ jobName: string, body: string, path: string }>}
 */
export function splitWorkflowIntoJobs(workflowPath) {
  const lines = readFileSync(workflowPath, "utf8").split("\n");

  let inJobs = false;
  let jobName = null;
  let jobStart = -1;
  const jobs = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      if (jobName !== null) {
        jobs.push({
          jobName,
          body: lines.slice(jobStart, i).join("\n"),
          path: workflowPath,
        });
      }
      jobName = jobMatch[1];
      jobStart = i;
    }
  }
  if (jobName !== null) {
    jobs.push({
      jobName,
      body: lines.slice(jobStart).join("\n"),
      path: workflowPath,
    });
  }
  return jobs;
}

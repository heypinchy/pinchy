import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the failed v0.5.0 release: the screenshots.yml
// workflow ran `docker compose up -d` without setting PINCHY_VERSION,
// after the `0a1e4ebd2 feat(compose): pin image versions via PINCHY_VERSION
// env var` switch made the variable required by the compose file. This is
// the second time this kind of bug appears (commit 2a07fecc6 fixed an
// earlier round of CI-job omissions). Without a guard, every new job that
// adds `docker compose up/pull/down` is a chance to regress release
// installability.
//
// Heuristic: any workflow JOB that runs `docker compose up`, `pull`, or
// `down` MUST mention PINCHY_VERSION somewhere within the same job (either
// in a step's env block, the job's env block, or in a `run:` body that
// writes/sets it on .env). The textual sweep keeps the test dependency-
// free; precision is enough because every legitimate compose-using job in
// this repo references PINCHY_VERSION literally.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

// Commands that interpolate ${PINCHY_VERSION} from docker-compose.yml.
const COMPOSE_CMDS = [
  /\bdocker\s+compose\s+up\b/,
  /\bdocker\s+compose\s+pull\b/,
  /\bdocker\s+compose\s+down\b/,
];

function listWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(WORKFLOW_DIR, f));
}

// Splits a workflow file into per-job text blocks. Returns
// { jobName, body } pairs. Jobs are detected as 2-space-indented top-level
// keys under the `jobs:` line. Body is the raw text from the job header
// up to (but not including) the next sibling job header.
function splitWorkflowIntoJobs(workflowPath) {
  const text = readFileSync(workflowPath, "utf8");
  const lines = text.split("\n");

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

function jobInvokesCompose(job) {
  return COMPOSE_CMDS.some((re) => re.test(job.body));
}

function jobReferencesPinchyVersion(job) {
  return /PINCHY_VERSION/.test(job.body);
}

test("every workflow job that invokes docker compose references PINCHY_VERSION", () => {
  const offenders = [];
  for (const wf of listWorkflows()) {
    for (const job of splitWorkflowIntoJobs(wf)) {
      if (!jobInvokesCompose(job)) continue;
      if (!jobReferencesPinchyVersion(job)) {
        const rel = job.path.replace(`${ROOT}/`, "");
        offenders.push(`${rel}::${job.jobName}`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `Workflow job(s) run docker compose without setting PINCHY_VERSION ` +
      `(neither step env, job env, nor .env file write). The compose file ` +
      `requires PINCHY_VERSION since 0a1e4ebd2 — without it docker compose ` +
      `up fails with "required variable PINCHY_VERSION is missing a value".\n` +
      `Offenders:\n  - ${offenders.join("\n  - ")}`,
  );
});

// Sanity: the helpers themselves work as intended. Catches a future drift
// where the splitter fails to find any jobs (e.g. workflow YAML restructure)
// which would silently let the main assertion pass with zero coverage.
test("workflow splitter actually finds jobs in our repo", () => {
  let totalJobs = 0;
  let totalComposeJobs = 0;
  for (const wf of listWorkflows()) {
    const jobs = splitWorkflowIntoJobs(wf);
    totalJobs += jobs.length;
    totalComposeJobs += jobs.filter(jobInvokesCompose).length;
  }
  assert.ok(totalJobs >= 10, `expected ≥10 jobs across workflows, got ${totalJobs}`);
  assert.ok(
    totalComposeJobs >= 3,
    `expected ≥3 compose-using jobs (release end-user-install, ci end-user-* etc.), got ${totalComposeJobs}`,
  );
});

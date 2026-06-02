import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Wiring guard for issue #438: a unit-tested version-match function and an
// /api/version smoke check only protect a release if release.yml actually
// invokes them. These textual sweeps fail if either guard is dropped from the
// workflow (e.g. a refactor that re-orders or deletes the step). Same
// dependency-free approach as workflow-compose-env.test.mjs.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_YML = join(ROOT, ".github", "workflows", "release.yml");

// Splits release.yml into per-job text blocks: { jobName, body }. Jobs are
// 2-space-indented top-level keys under the `jobs:` line; a job's body runs
// from its header up to (but not including) the next sibling job header.
function splitWorkflowIntoJobs(workflowPath) {
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
        jobs.push({ jobName, body: lines.slice(jobStart, i).join("\n") });
      }
      jobName = jobMatch[1];
      jobStart = i;
    }
  }
  if (jobName !== null) {
    jobs.push({ jobName, body: lines.slice(jobStart).join("\n") });
  }
  return jobs;
}

function jobBody(name) {
  const job = splitWorkflowIntoJobs(RELEASE_YML).find((j) => j.jobName === name);
  assert.ok(job, `release.yml has no '${name}' job (workflow restructured?)`);
  return job.body;
}

// Layer 2: build-time version-match guard.

test("release.yml docker job runs the package-version assert", () => {
  const body = jobBody("docker");
  assert.match(
    body,
    /assert-package-version\.mjs/,
    "docker job must run scripts/assert-package-version.mjs to catch tag/version drift",
  );
});

test("release.yml asserts the version before pushing any image", () => {
  const body = jobBody("docker");
  const assertIdx = body.indexOf("assert-package-version.mjs");
  const buildPushIdx = body.indexOf("docker/build-push-action");
  assert.ok(assertIdx !== -1, "version assert step is missing");
  assert.ok(buildPushIdx !== -1, "build-push step is missing");
  assert.ok(
    assertIdx < buildPushIdx,
    "the version assert must run before docker/build-push-action so a stale " +
      "version fails the workflow before any GHCR push",
  );
});

// Layer 3: runtime /api/version smoke check.

test("release.yml end-user-install job smoke-checks /api/version against the tag", () => {
  const body = jobBody("end-user-install-published");
  assert.match(
    body,
    /\/api\/version/,
    "end-user-install-published must query /api/version to verify the runtime " +
      "reports the released version",
  );
  assert.match(
    body,
    /pinchyVersion/,
    "the smoke check must read the pinchyVersion field from /api/version",
  );
  // The reported pinchyVersion carries no leading 'v', so a correct comparison
  // must strip it from the tag. `RELEASE_TAG#v` is unique to the smoke step —
  // the pre-existing .env step uses ${RELEASE_TAG} unstripped — so this also
  // ties the assertion to the smoke check rather than any RELEASE_TAG mention.
  assert.match(
    body,
    /RELEASE_TAG#v/,
    "the smoke check must compare /api/version against the v-stripped release tag",
  );
});

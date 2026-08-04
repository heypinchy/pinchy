import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readJobTimeout, validateJobTimeouts } from "./workflow-timeouts.mjs";
import { splitWorkflowIntoJobs } from "./workflow-jobs.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github/workflows");

test("readJobTimeout reads a job-level timeout-minutes", () => {
  const body = [
    "  quality:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 35",
    "    steps:",
  ].join("\n");
  assert.deepEqual(readJobTimeout(body), { minutes: 35 });
});

test("readJobTimeout reports a missing timeout, not a false pass", () => {
  const body = ["  quality:", "    runs-on: ubuntu-latest", "    steps:"].join(
    "\n",
  );
  const result = readJobTimeout(body);
  assert.ok("error" in result);
  assert.match(result.error, /sets no job-level timeout-minutes/);
});

test("readJobTimeout ignores a STEP-level timeout-minutes (8-space indent)", () => {
  // A step can carry its own timeout-minutes; that is a different setting
  // and must not be read as satisfying the job-level requirement.
  const body = [
    "  quality:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: slow step",
    "        timeout-minutes: 5",
  ].join("\n");
  const result = readJobTimeout(body);
  assert.ok("error" in result);
});

test("readJobTimeout rejects a non-numeric value", () => {
  const body = ["  quality:", "    timeout-minutes: soon"].join("\n");
  const result = readJobTimeout(body);
  assert.ok("error" in result);
  assert.match(result.error, /not a positive number/);
});

test("readJobTimeout strips a trailing comment", () => {
  const body = ["  quality:", "    timeout-minutes: 35 # ~4x observed"].join(
    "\n",
  );
  assert.deepEqual(readJobTimeout(body), { minutes: 35 });
});

test("validateJobTimeouts flags every job missing a timeout, not just the first", () => {
  const jobs = [
    {
      jobName: "a",
      path: "w.yml",
      body: "  a:\n    timeout-minutes: 10\n    steps:",
    },
    { jobName: "b", path: "w.yml", body: "  b:\n    steps:" },
    { jobName: "c", path: "w.yml", body: "  c:\n    steps:" },
  ];
  const errors = validateJobTimeouts(jobs);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes('"b"')));
  assert.ok(errors.some((e) => e.includes('"c"')));
});

test("validateJobTimeouts enforces the minimum-minutes floor", () => {
  const jobs = [
    {
      jobName: "quick",
      path: "w.yml",
      body: "  quick:\n    timeout-minutes: 2\n    steps:",
    },
  ];
  const errors = validateJobTimeouts(jobs);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /below the 10-minute floor/);
});

test("validateJobTimeouts accepts a custom floor", () => {
  const jobs = [
    {
      jobName: "quick",
      path: "w.yml",
      body: "  quick:\n    timeout-minutes: 2\n    steps:",
    },
  ];
  assert.deepEqual(validateJobTimeouts(jobs, { minimumMinutes: 1 }), []);
});

test("a coherent job produces no errors", () => {
  const jobs = [
    {
      jobName: "quality",
      path: "ci.yml",
      body: "  quality:\n    timeout-minutes: 35\n    steps:",
    },
  ];
  assert.deepEqual(validateJobTimeouts(jobs), []);
});

/** Every job, across every workflow file this repo tracks. */
function readAllWorkflowJobs() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .flatMap((name) =>
      splitWorkflowIntoJobs(join(WORKFLOW_DIR, name)).map((job) => ({
        ...job,
        path: `.github/workflows/${name}`,
      })),
    );
}

// The assertion that matters: not that the validator works on fixtures, but
// that every job in this repo's real workflows sets one. GitHub's default
// (360 minutes) is what a missing job silently inherits, so this is a floor
// under a hang, not a style preference.
test("every job in every workflow sets a job-level timeout-minutes", () => {
  const jobs = readAllWorkflowJobs();

  // Guards the guard: if the workflow directory goes empty or the splitter
  // stops finding jobs, the loop below passes vacuously.
  assert.ok(
    jobs.length >= 20,
    `found only ${jobs.length} jobs across .github/workflows — the splitter may not be reading them`,
  );

  const errors = validateJobTimeouts(jobs);
  assert.deepEqual(errors, [], errors.join("\n"));
});

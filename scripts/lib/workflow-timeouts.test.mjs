import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  isReusableWorkflowCall,
  readJobTimeout,
  validateJobTimeouts,
} from "./workflow-timeouts.mjs";
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

test("readJobTimeout reads the number past a trailing comment", () => {
  const spaced = ["  quality:", "    timeout-minutes: 35 # ~4x observed"].join(
    "\n",
  );
  assert.deepEqual(readJobTimeout(spaced), { minutes: 35 });
  // The unspaced form is not valid YAML (it parses as the string "35#…"),
  // but the reader strips it rather than reporting a bogus "not a number".
  const unspaced = ["  quality:", "    timeout-minutes: 35#observed"].join(
    "\n",
  );
  assert.deepEqual(readJobTimeout(unspaced), { minutes: 35 });
});

test("isReusableWorkflowCall sees a job-level uses:, not a step's", () => {
  const call = [
    "  vuln-scan:",
    "    needs: changes",
    "    uses: some/org/.github/workflows/scan.yml@v1",
  ].join("\n");
  assert.equal(isReusableWorkflowCall(call), true);

  const steps = [
    "  quality:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - name: setup",
    "        uses: actions/setup-node@v4",
  ].join("\n");
  assert.equal(isReusableWorkflowCall(steps), false);
});

// The regression this guard exists for. A reusable-workflow call accepts
// only name/uses/with/secrets/needs/if/permissions; a `timeout-minutes`
// there makes GitHub reject the WHOLE FILE, so the run ends at 0s with no
// jobs and no status reported — on ci.yml, that is every required check
// silently never arriving. Both directions are asserted: exempt from
// needing one, rejected for having one.
test("validateJobTimeouts exempts a reusable-workflow call from needing a timeout", () => {
  const jobs = [
    {
      jobName: "vuln-scan",
      path: "ci.yml",
      body: "  vuln-scan:\n    needs: changes\n    uses: some/org/.github/workflows/scan.yml@v1",
    },
  ];
  assert.deepEqual(validateJobTimeouts(jobs), []);
});

test("validateJobTimeouts rejects a timeout ON a reusable-workflow call", () => {
  const jobs = [
    {
      jobName: "vuln-scan",
      path: "ci.yml",
      body: "  vuln-scan:\n    timeout-minutes: 10\n    uses: some/org/.github/workflows/scan.yml@v1",
    },
  ];
  const errors = validateJobTimeouts(jobs);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rejects the entire workflow file/);
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

// Guards the guard, and a total floor is not enough to do it: a splitter
// that reads most files but silently returns nothing for one would still
// clear `>= 20` on ci.yml alone, and the file it dropped would be checked by
// nothing. So every workflow file must yield at least one job.
test("the sweep reads every workflow file, not merely most of them", () => {
  const files = readdirSync(WORKFLOW_DIR).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );
  assert.ok(
    files.length >= 8,
    `found only ${files.length} workflow files — is WORKFLOW_DIR right?`,
  );

  const empty = files.filter(
    (name) => splitWorkflowIntoJobs(join(WORKFLOW_DIR, name)).length === 0,
  );
  assert.deepEqual(
    empty,
    [],
    `these workflow files yielded no jobs, so nothing checked them: ${empty.join(", ")}`,
  );

  assert.ok(
    readAllWorkflowJobs().length >= 20,
    "found fewer than 20 jobs across .github/workflows — the splitter may not be reading them",
  );
});

// The exemption has to stay exercised against the real tree, not only
// against fixtures: if ci.yml's `vuln-scan` ever stopped being read as a
// reusable-workflow call, the guard would start demanding the very
// `timeout-minutes` that makes GitHub reject the whole file.
test("the real workflows still contain a reusable-workflow call, and it carries no timeout", () => {
  const calls = readAllWorkflowJobs().filter((job) =>
    isReusableWorkflowCall(job.body),
  );
  assert.ok(
    calls.length >= 1,
    "no reusable-workflow call found in .github/workflows — the exemption branch is now untested against reality",
  );
  for (const job of calls) {
    assert.equal(
      readJobTimeout(job.body).minutes,
      undefined,
      `${job.path} job "${job.jobName}" calls a reusable workflow and must not set timeout-minutes`,
    );
  }
});

// The assertion that matters: not that the validator works on fixtures, but
// that every job in this repo's real workflows sets one. GitHub's default
// (360 minutes) is what a missing job silently inherits, so this is a floor
// under a hang, not a style preference.
test("every job in every workflow sets a job-level timeout-minutes", () => {
  const errors = validateJobTimeouts(readAllWorkflowJobs());
  assert.deepEqual(errors, [], errors.join("\n"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitWorkflowIntoJobs } from "./workflow-jobs.mjs";
import {
  hasCodeChanges,
  UNGATED_JOBS,
  REQUIRED_JOBS,
  GATE_EXPRESSION,
} from "./ci-path-filter.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");

// ---------------------------------------------------------------------------
// hasCodeChanges: which changed files justify the expensive CI matrix
// ---------------------------------------------------------------------------

test("a source change is a code change", () => {
  assert.equal(hasCodeChanges(["packages/web/src/lib/auth.ts"]), true);
});

test("docs-only, markdown-only and sample-data-only changes are not code changes", () => {
  assert.equal(
    hasCodeChanges(["docs/src/content/docs/guides/agents.mdx"]),
    false,
  );
  assert.equal(hasCodeChanges(["README.md"]), false);
  assert.equal(hasCodeChanges(["PERSONALITY.md"]), false);
  assert.equal(hasCodeChanges(["packages/web/README.md"]), false);
  assert.equal(hasCodeChanges([".github/ISSUE_TEMPLATE/bug.yml"]), false);
  assert.equal(hasCodeChanges(["sample-data/handbook.txt"]), false);
  assert.equal(hasCodeChanges(["screenshots/chat.png"]), false);
});

test("one code file among many docs files still makes it a code change", () => {
  assert.equal(
    hasCodeChanges(["docs/a.mdx", "README.md", "packages/web/src/x.ts"]),
    true,
  );
});

// A workflow edit changes CI itself — it must never skip the matrix that would
// prove the edit works. `.github/ISSUE_TEMPLATE/**` is the deliberate exception.
test("a workflow change is a code change", () => {
  assert.equal(hasCodeChanges([".github/workflows/ci.yml"]), true);
});

// docs/ is prose, but its lockfile is a dependency manifest that vuln-scan
// actually reads. Classifying a docs-lockfile security bump as "docs-only"
// would skip the very scan that proves the fix, leaving main red until someone
// hand-ran workflow_dispatch. The guard below pins this to vuln-scan's config.
test("the docs lockfile is a code change even though it lives under docs/", () => {
  assert.equal(hasCodeChanges(["docs/pnpm-lock.yaml"]), true);
});

test("docs prose next to the lockfile is still not a code change", () => {
  assert.equal(hasCodeChanges(["docs/src/content/docs/index.mdx"]), false);
});

// An .mdx outside docs/ is matched by neither `docs/**` nor `**/*.md`. Treating
// it as code is the safe direction: it may be a component fixture, not prose.
test("an mdx file outside docs/ is a code change", () => {
  assert.equal(hasCodeChanges(["packages/web/src/content/note.mdx"]), true);
});

// An empty diff means we failed to work out what changed (shallow clone, force
// push, unresolvable base). Guessing "docs only" there would silently skip the
// whole matrix on a real code change, so an unknown diff must run everything.
test("an empty or unknown file list runs the full matrix", () => {
  assert.equal(hasCodeChanges([]), true);
});

test("blank lines from a git diff are ignored, not treated as code", () => {
  assert.equal(hasCodeChanges(["README.md", "", "  "]), false);
});

// ---------------------------------------------------------------------------
// Drift guards: the wiring that makes the filter safe
// ---------------------------------------------------------------------------

// The bug this whole mechanism replaces: ci.yml was `paths-ignore`d for docs,
// so a docs-only PR never STARTED the workflow — and a required check that
// never runs never reports, leaving the PR permanently stuck on "Expected —
// Waiting for status to be reported". Job-level gating (below) is the fix
// precisely because the workflow still starts and still reports.
test("ci.yml has no paths-ignore — it must always start so required checks report", () => {
  const yaml = readFileSync(CI_WORKFLOW, "utf8");
  const uncommented = yaml
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
  assert.ok(
    !/paths-ignore:/.test(uncommented),
    "ci.yml must not use paths-ignore: it hosts required status checks, and a workflow that never starts blocks the PR forever. Gate individual jobs on the `changes` job instead.",
  );
});

// The merge-queue counterpart of the paths-ignore guard above. main's required
// checks live in this workflow, and the merge queue tests each entry on a
// `gh-readonly-queue/...` merge ref via the `merge_group` event. Without that
// trigger the workflow never starts for a queued PR, the required checks never
// report on the merge ref, and the queue sits forever waiting for a status that
// can't arrive — the same "stuck forever" failure mode, just one level up. If
// the queue is ever abandoned, dropping the trigger is a deliberate act; this
// guard makes it one.
test("ci.yml triggers on merge_group so required checks report to the merge queue", () => {
  const yaml = readFileSync(CI_WORKFLOW, "utf8");
  const uncommented = yaml
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
  assert.ok(
    /^ {2}merge_group:/m.test(uncommented),
    "ci.yml must list `merge_group:` under `on:` — without it the merge queue never gets a status from the required checks and every queued PR hangs indefinitely.",
  );
});

// A required check must report on EVERY pull request, so it must not be gated —
// not even behind the changes job, which would make it depend on GitHub's subtle
// "a skipped job counts as success" behaviour for the one thing protecting main.
// The other UNGATED_JOBS are ungated for a weaker reason (see the list), but the
// list still has to describe ci.yml or it is just a comment that lies.
test("every job listed as ungated really is ungated", () => {
  const jobs = splitWorkflowIntoJobs(CI_WORKFLOW);
  for (const [name, reason] of Object.entries(UNGATED_JOBS)) {
    const job = jobs.find((j) => j.jobName === name);
    assert.ok(
      job,
      `ci.yml must define the job "${name}" listed in UNGATED_JOBS`,
    );
    assert.ok(
      !job.body.includes("needs.changes"),
      `"${name}" is listed in UNGATED_JOBS (${reason}) but is gated on the changes job in ci.yml — either drop the gate or drop the listing`,
    );
  }
});

test("REQUIRED_JOBS is the branch-protection subset of UNGATED_JOBS", () => {
  for (const name of REQUIRED_JOBS) {
    assert.equal(
      UNGATED_JOBS[name],
      "required",
      `"${name}" must be listed as required in UNGATED_JOBS`,
    );
  }
});

// Without this, a newly added job silently runs the full Docker/E2E matrix on
// every README typo — the cost the removed paths-ignore used to avoid.
test("every other job is gated on the changes job", () => {
  const exempt = new Set([...Object.keys(UNGATED_JOBS), "changes"]);
  const offenders = splitWorkflowIntoJobs(CI_WORKFLOW)
    .filter((job) => !exempt.has(job.jobName))
    .filter((job) => !job.body.includes(GATE_EXPRESSION))
    .map((job) => job.jobName);

  assert.deepEqual(
    offenders,
    [],
    `these ci.yml jobs must be skipped on docs-only PRs — add \`needs: changes\` and \`if: ${GATE_EXPRESSION}\`: ${offenders.join(", ")}`,
  );
});

// Ties the filter to what the scanner actually reads. vuln-scan is gated, so a
// lockfile it scans must count as code — otherwise the PR that bumps that
// lockfile to fix a vulnerability skips the scan that would prove the fix. This
// fires if someone adds a --lockfile under an ignored path (e.g. a second docs
// site) without teaching the filter about it.
test("every lockfile vuln-scan reads counts as a code change", () => {
  const vulnScan = splitWorkflowIntoJobs(CI_WORKFLOW).find(
    (j) => j.jobName === "vuln-scan",
  );
  assert.ok(vulnScan, "ci.yml must define the vuln-scan job");

  const lockfiles = [...vulnScan.body.matchAll(/--lockfile=\.\/(\S+)/g)].map(
    (m) => m[1],
  );
  assert.ok(
    lockfiles.length > 0,
    "expected vuln-scan to scan at least one lockfile",
  );

  const invisible = lockfiles.filter((path) => !hasCodeChanges([path]));
  assert.deepEqual(
    invisible,
    [],
    `vuln-scan reads these lockfiles, but the filter treats them as docs — a security bump there would skip the scan: ${invisible.join(", ")}`,
  );
});

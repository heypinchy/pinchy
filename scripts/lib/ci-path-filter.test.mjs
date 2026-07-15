import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitWorkflowIntoJobs } from "./workflow-jobs.mjs";
import { hasCodeChanges, ALWAYS_RUN_JOBS, GATE_EXPRESSION } from "./ci-path-filter.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");

// ---------------------------------------------------------------------------
// hasCodeChanges: which changed files justify the expensive CI matrix
// ---------------------------------------------------------------------------

test("a source change is a code change", () => {
  assert.equal(hasCodeChanges(["packages/web/src/lib/auth.ts"]), true);
});

test("docs-only, markdown-only and sample-data-only changes are not code changes", () => {
  assert.equal(hasCodeChanges(["docs/src/content/docs/guides/agents.mdx"]), false);
  assert.equal(hasCodeChanges(["README.md"]), false);
  assert.equal(hasCodeChanges(["PERSONALITY.md"]), false);
  assert.equal(hasCodeChanges(["packages/web/README.md"]), false);
  assert.equal(hasCodeChanges([".github/ISSUE_TEMPLATE/bug.yml"]), false);
  assert.equal(hasCodeChanges(["sample-data/handbook.txt"]), false);
  assert.equal(hasCodeChanges(["screenshots/chat.png"]), false);
});

test("one code file among many docs files still makes it a code change", () => {
  assert.equal(hasCodeChanges(["docs/a.mdx", "README.md", "packages/web/src/x.ts"]), true);
});

// A workflow edit changes CI itself — it must never skip the matrix that would
// prove the edit works. `.github/ISSUE_TEMPLATE/**` is the deliberate exception.
test("a workflow change is a code change", () => {
  assert.equal(hasCodeChanges([".github/workflows/ci.yml"]), true);
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
    "ci.yml must not use paths-ignore: it hosts required status checks, and a workflow that never starts blocks the PR forever. Gate individual jobs on the `changes` job instead."
  );
});

// These are the jobs named in main's branch protection. A required check must
// report on EVERY pull request, so it must not be gated — not even behind the
// changes job, which would make it depend on GitHub's subtle "a skipped job
// counts as success" behaviour for the one thing protecting main.
test("required-check jobs are never gated", () => {
  const jobs = splitWorkflowIntoJobs(CI_WORKFLOW);
  for (const name of ALWAYS_RUN_JOBS) {
    const job = jobs.find((j) => j.jobName === name);
    assert.ok(job, `ci.yml must define the required-check job "${name}"`);
    assert.ok(
      !job.body.includes("needs.changes"),
      `"${name}" is a required status check and must run on every PR, so it must not be gated on the changes job`
    );
  }
});

// Without this, a newly added job silently runs the full Docker/E2E matrix on
// every README typo — the cost the removed paths-ignore used to avoid.
test("every other job is gated on the changes job", () => {
  const exempt = new Set([...ALWAYS_RUN_JOBS, "changes"]);
  const offenders = splitWorkflowIntoJobs(CI_WORKFLOW)
    .filter((job) => !exempt.has(job.jobName))
    .filter((job) => !job.body.includes(GATE_EXPRESSION))
    .map((job) => job.jobName);

  assert.deepEqual(
    offenders,
    [],
    `these ci.yml jobs must be skipped on docs-only PRs — add \`needs: changes\` and \`if: ${GATE_EXPRESSION}\`: ${offenders.join(", ")}`
  );
});

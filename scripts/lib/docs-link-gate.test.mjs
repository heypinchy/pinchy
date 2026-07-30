import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { validateDocsPackage, validateCiWiring } from "./docs-link-gate.mjs";
import { splitWorkflowIntoJobs } from "./workflow-jobs.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = join(REPO_ROOT, "docs");

const WIRED_JOB = [
  "      - name: Docs build",
  "        run: cd docs && pnpm build",
  "",
  "      - name: Docs anchor check (built output)",
  "        run: cd docs && pnpm check:anchors",
].join("\n");

// ── docs/package.json ─────────────────────────────────────────────────────

test("validateDocsPackage accepts a package that wires the check script", () => {
  assert.deepEqual(
    validateDocsPackage({
      scripts: { "check:anchors": "node scripts/check-anchors.mjs" },
    }),
    [],
  );
});

test("validateDocsPackage flags a missing check script", () => {
  const problems = validateDocsPackage({ scripts: { build: "astro build" } });
  assert.ok(problems.some((p) => /check:anchors/.test(p)));
});

test("validateDocsPackage flags a check script pointed elsewhere", () => {
  // e.g. repointed at check-no-tables-in-lists.mjs during a refactor: the
  // script name survives, the check it runs does not.
  const problems = validateDocsPackage({
    scripts: { "check:anchors": "node scripts/check-no-tables-in-lists.mjs" },
  });
  assert.ok(problems.some((p) => /check-anchors\.mjs/.test(p)));
});

test("validateDocsPackage reports a problem (not a throw) on a non-object", () => {
  assert.ok(validateDocsPackage(null).length > 0);
  assert.ok(validateDocsPackage("oops").length > 0);
});

// ── .github/workflows/ci.yml ──────────────────────────────────────────────

test("validateCiWiring accepts a quality job that builds then checks", () => {
  assert.deepEqual(validateCiWiring(WIRED_JOB), []);
});

test("validateCiWiring flags a quality job that never runs the check", () => {
  assert.ok(
    validateCiWiring("      - run: cd docs && pnpm build\n").some((p) =>
      /check:anchors/.test(p),
    ),
  );
});

test("validateCiWiring flags a quality job that never builds the docs", () => {
  assert.ok(
    validateCiWiring("      - run: cd docs && pnpm check:anchors\n").some((p) =>
      /pnpm build/.test(p),
    ),
  );
});

test("validateCiWiring flags the check running BEFORE the build", () => {
  // The checker reads docs/dist/. Ahead of the build it either exits 1 on a
  // missing dist or — on a warm runner — passes against yesterday's HTML.
  const reversed = [
    "      - run: cd docs && pnpm check:anchors",
    "      - run: cd docs && pnpm build",
  ].join("\n");
  assert.ok(validateCiWiring(reversed).some((p) => /AFTER/.test(p)));
});

test("validateCiWiring flags steps that are only present as comments", () => {
  const commented = WIRED_JOB.split("\n")
    .map((line) => (line.trim() === "" ? line : line.replace(/^(\s*)/, "$1# ")))
    .join("\n");
  assert.equal(
    validateCiWiring(commented).length,
    2,
    "a commented-out step must not satisfy the guard",
  );
});

test("validateCiWiring does not treat a '#' inside a command as a comment", () => {
  // A naive /#.*$/ strip would truncate this line before the command and
  // falsely report the gate as un-wired.
  const withHash =
    '      - run: echo "#docs" && cd docs && pnpm build\n' +
    "      - run: cd docs && pnpm check:anchors\n";
  assert.deepEqual(validateCiWiring(withHash), []);
});

// ── Drift guards against the REAL repo files ──────────────────────────────

test("docs/package.json wires the check:anchors script", () => {
  const pkg = JSON.parse(readFileSync(join(DOCS, "package.json"), "utf8"));
  assert.deepEqual(validateDocsPackage(pkg), []);
});

test("CI's quality job builds the docs and then checks the anchors", () => {
  const quality = splitWorkflowIntoJobs(
    join(REPO_ROOT, ".github", "workflows", "ci.yml"),
  ).find((job) => job.jobName === "quality");
  assert.ok(quality, "ci.yml has no `quality` job");
  assert.deepEqual(
    validateCiWiring(quality.body),
    [],
    "the anchor check moved out of `quality` — a docs check that skips on docs-only PRs is the bug #764 fixed",
  );
});

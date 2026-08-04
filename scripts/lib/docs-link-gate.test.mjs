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
  "",
  "      - name: Docs rendered-table check (built output)",
  "        run: cd docs && pnpm check:rendered",
  "",
  "      - name: Docs llms.txt check (built output)",
  "        run: cd docs && pnpm check:llms",
  "",
  "      - name: Docs script tests",
  "        run: cd docs && pnpm test",
].join("\n");

const WIRED_SCRIPTS = {
  build:
    "sh scripts/with-restore.sh sh -c 'astro build && node scripts/generate-llms-txt.mjs'",
  test: "node --test scripts/*.test.mjs",
  "check:anchors": "node scripts/check-anchors.mjs",
  "check:rendered": "node scripts/check-rendered-tables.mjs",
  "check:llms": "node scripts/check-llms-txt.mjs",
};

// ── docs/package.json ─────────────────────────────────────────────────────

test("validateDocsPackage accepts a package that wires the check script", () => {
  assert.deepEqual(validateDocsPackage({ scripts: { ...WIRED_SCRIPTS } }), []);
});

test("validateDocsPackage flags a missing check script", () => {
  const problems = validateDocsPackage({ scripts: { build: "astro build" } });
  assert.ok(problems.some((p) => /check:anchors/.test(p)));
});

test("validateDocsPackage flags a missing rendered-table script", () => {
  // The gfm regression is the reason this second check exists; dropping its
  // script while keeping the anchor one must not read as "wired".
  const problems = validateDocsPackage({
    scripts: { "check:anchors": WIRED_SCRIPTS["check:anchors"] },
  });
  assert.ok(problems.some((p) => /check:rendered/.test(p)));
});

test("validateDocsPackage flags a check script pointed elsewhere", () => {
  // e.g. repointed at check-no-tables-in-lists.mjs during a refactor: the
  // script name survives, the check it runs does not.
  const problems = validateDocsPackage({
    scripts: {
      ...WIRED_SCRIPTS,
      "check:anchors": "node scripts/check-no-tables-in-lists.mjs",
    },
  });
  assert.ok(problems.some((p) => /check-anchors\.mjs/.test(p)));
});

test("validateDocsPackage flags the rendered-table script pointed elsewhere", () => {
  const problems = validateDocsPackage({
    scripts: {
      ...WIRED_SCRIPTS,
      "check:rendered": "node scripts/check-no-tables-in-lists.mjs",
    },
  });
  assert.ok(problems.some((p) => /check-rendered-tables\.mjs/.test(p)));
});

test("validateDocsPackage flags a missing llms.txt check", () => {
  // The AI-crawler view of the docs. Committed by hand it went months stale
  // (#1080); generated, the only thing proving it still matches the built site
  // is this check.
  const { "check:llms": _dropped, ...withoutLlms } = WIRED_SCRIPTS;
  const problems = validateDocsPackage({ scripts: withoutLlms });
  assert.ok(problems.some((p) => /check:llms/.test(p)));
});

test("validateDocsPackage flags a build that stopped generating llms.txt", () => {
  // Silently narrowing the gate from the other side: the check survives, the
  // thing it checks is never produced.
  const problems = validateDocsPackage({
    scripts: { ...WIRED_SCRIPTS, build: "astro build" },
  });
  assert.ok(problems.some((p) => /generate-llms-txt\.mjs/.test(p)));
});

test("validateDocsPackage flags a missing build script", () => {
  const { build: _dropped, ...withoutBuild } = WIRED_SCRIPTS;
  const problems = validateDocsPackage({ scripts: withoutBuild });
  assert.ok(problems.some((p) => /"build"/.test(p)));
});

test("validateDocsPackage flags a missing test script", () => {
  // The checkers' own unit tests are the only thing pinning their logic. A
  // checker rewritten to return nothing passes against a healthy dist/ — the
  // tests are what notice, so the script that runs them is part of the gate.
  const { test: _dropped, ...withoutTests } = WIRED_SCRIPTS;
  const problems = validateDocsPackage({ scripts: withoutTests });
  assert.ok(problems.some((p) => /"test"/.test(p)));
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

test("validateCiWiring flags a quality job that never runs the rendered-table check", () => {
  const anchorsOnly = [
    "      - run: cd docs && pnpm build",
    "      - run: cd docs && pnpm check:anchors",
  ].join("\n");
  assert.ok(
    validateCiWiring(anchorsOnly).some((p) => /check:rendered/.test(p)),
  );
});

test("validateCiWiring flags a quality job that never runs the docs script tests", () => {
  // Both checkers ship with unit tests that CI ignored until #1007. A gate
  // whose own logic is unverified reports on what it happens to do, not on
  // what it is supposed to do.
  const checksOnly = [
    "      - run: cd docs && pnpm build",
    "      - run: cd docs && pnpm check:anchors",
    "      - run: cd docs && pnpm check:rendered",
  ].join("\n");
  assert.ok(validateCiWiring(checksOnly).some((p) => /pnpm test/.test(p)));
});

test("validateCiWiring flags the check running BEFORE the build", () => {
  // The checker reads docs/dist/. Ahead of the build it either exits 1 on a
  // missing dist or — on a warm runner — passes against yesterday's HTML.
  const reversed = [
    "      - run: cd docs && pnpm check:anchors",
    "      - run: cd docs && pnpm check:rendered",
    "      - run: cd docs && pnpm build",
  ].join("\n");
  const problems = validateCiWiring(reversed);
  assert.ok(problems.some((p) => /check:anchors.*AFTER/.test(p)));
  assert.ok(problems.some((p) => /check:rendered.*AFTER/.test(p)));
});

test("validateCiWiring flags steps that are only present as comments", () => {
  const commented = WIRED_JOB.split("\n")
    .map((line) => (line.trim() === "" ? line : line.replace(/^(\s*)/, "$1# ")))
    .join("\n");
  assert.equal(
    validateCiWiring(commented).length,
    5,
    "a commented-out step must not satisfy the guard",
  );
});

test("validateCiWiring does not treat a '#' inside a command as a comment", () => {
  // A naive /#.*$/ strip would truncate this line before the command and
  // falsely report the gate as un-wired.
  const withHash =
    '      - run: echo "#docs" && cd docs && pnpm build\n' +
    "      - run: cd docs && pnpm check:anchors\n" +
    "      - run: cd docs && pnpm check:rendered\n" +
    "      - run: cd docs && pnpm check:llms\n" +
    "      - run: cd docs && pnpm test\n";
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

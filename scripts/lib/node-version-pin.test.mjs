import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  parseNvmrc,
  expectedEnginesRange,
  extractWorkflowNodeVersions,
  validateNodeVersionPin,
} from "./node-version-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("parseNvmrc reads a bare major, a full version, and a v prefix", () => {
  assert.deepEqual(parseNvmrc("22"), { major: 22 });
  assert.deepEqual(parseNvmrc("22.14.0\n"), { major: 22 });
  assert.deepEqual(parseNvmrc("v22.14.0"), { major: 22 });
});

test("parseNvmrc rejects an alias, which is drift wearing a pin's clothes", () => {
  // `lts/*` resolves to a different major as the calendar moves, so two
  // machines reading the same file can run different Node. That is the exact
  // failure the pin exists to prevent.
  const result = parseNvmrc("lts/*");
  assert.ok("error" in result);
  assert.match(result.error, /alias/i);
});

test("extractWorkflowNodeVersions finds plain, quoted, and interpolated values", () => {
  const yaml = [
    "      - uses: actions/setup-node@v6",
    "        with:",
    "          node-version: 22",
    "          node-version: '20'",
    '          node-version: "18"',
    "          node-version: ${{ matrix.node }}",
  ].join("\n");
  assert.deepEqual(extractWorkflowNodeVersions(yaml), [
    "22",
    "20",
    "18",
    "${{",
  ]);
});

test("a coherent pin produces no errors", () => {
  assert.deepEqual(
    validateNodeVersionPin({
      nvmrc: "22\n",
      enginesNode: ">=22 <23",
      workflows: [{ file: "ci.yml", versions: ["22"] }],
    }),
    [],
  );
});

test("a missing .nvmrc is reported on its own, without cascading", () => {
  const errors = validateNodeVersionPin({
    nvmrc: null,
    enginesNode: undefined,
    workflows: [{ file: "ci.yml", versions: ["22"] }],
  });
  // One message, not three: with no pin there is nothing for engines or the
  // workflows to disagree WITH, and three errors would bury the one fix.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No \.nvmrc/);
});

test("an open-ended engines range is rejected, since it admits every future major", () => {
  // ">=22" is the tempting shape and the useless one: Node 25 satisfies it,
  // which is the version that produced the ABI mismatch behind this guard.
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22",
    workflows: [],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], />=22 <23/);
});

test("a workflow that drifts from .nvmrc names the file and both versions", () => {
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22 <23",
    workflows: [
      { file: ".github/workflows/ci.yml", versions: ["22"] },
      { file: ".github/workflows/docs.yml", versions: ["24"] },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /docs\.yml/);
  assert.match(errors[0], /24/);
  assert.match(errors[0], /22/);
});

test("every node-version in a workflow is checked, not just the first", () => {
  // A workflow with several setup-node steps is the easy place to bump one and
  // miss another.
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22 <23",
    workflows: [{ file: "ci.yml", versions: ["22", "24"] }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /24/);
});

test("expectedEnginesRange bounds the major above as well as below", () => {
  assert.equal(expectedEnginesRange(22), ">=22 <23");
  assert.equal(expectedEnginesRange(9), ">=9 <10");
});

// The assertion that matters: not that the validators work on fixtures, but
// that THIS repo is pinned coherently right now.
test("the repo pins one Node version across .nvmrc, engines, and every workflow", () => {
  const nvmrcPath = join(REPO_ROOT, ".nvmrc");
  const nvmrc = existsSync(nvmrcPath) ? readFileSync(nvmrcPath, "utf8") : null;

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  const workflowDir = join(REPO_ROOT, ".github/workflows");
  const workflows = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({
      file: `.github/workflows/${name}`,
      versions: extractWorkflowNodeVersions(
        readFileSync(join(workflowDir, name), "utf8"),
      ),
    }));

  // Guards the guard: if setup-node disappears from every workflow, the loop
  // above has nothing to compare and would pass vacuously.
  assert.ok(
    workflows.some((workflow) => workflow.versions.length > 0),
    "no workflow declares node-version — this check would pass without checking anything",
  );

  const errors = validateNodeVersionPin({
    nvmrc,
    enginesNode: pkg.engines?.node,
    workflows,
  });
  assert.deepEqual(errors, [], errors.join("\n"));
});

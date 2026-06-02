import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end coverage for the CLI glue around assertVersionMatchesTag: argv
// parsing, file reading, and — most importantly — the exit codes release.yml
// relies on to fail the workflow. The pure comparison is unit-tested in
// release-logic.test.mjs; this exercises the script as the workflow runs it.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "assert-package-version.mjs");
const REPO_VERSION = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;

// Runs the CLI and returns { status, stdout, stderr }. execFileSync throws on a
// non-zero exit, so the catch path normalizes both outcomes into one shape.
function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

test("CLI exits 0 when the tag matches the repo's package versions", () => {
  const result = runCli([`v${REPO_VERSION}`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`match v${REPO_VERSION.replace(/\./g, "\\.")}`));
});

test("CLI exits 1 with a ::error:: annotation on version drift", () => {
  const result = runCli(["v99.99.99"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
  assert.match(result.stdout, /pnpm release 99\.99\.99/);
});

test("CLI exits 1 with usage when no tag is given", () => {
  const result = runCli([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end coverage for the CLI glue around assertVersionMatchesTag: argv
// parsing, file reading, and — most importantly — the exit codes release.yml
// relies on to fail the workflow. The pure comparison is unit-tested in
// release-logic.test.mjs; this exercises the script as the workflow runs it.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "assert-package-version.mjs");
const REPO_VERSION = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8"),
).version;

// Runs the CLI and returns { status, stdout, stderr }. execFileSync throws on a
// non-zero exit, so the catch path normalizes both outcomes into one shape.
function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

// Against a fixture rather than the repo. Since #1044 the working tree declares
// `<next>-dev` at every moment that is not a release commit, so the repo can no
// longer play the part of a release commit.
test("CLI exits 0 when the tag matches the package versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinchy-version-"));
  mkdirSync(join(dir, "packages", "web"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "version": "1.2.3" }\n');
  writeFileSync(
    join(dir, "packages", "web", "package.json"),
    '{ "version": "1.2.3" }\n',
  );

  const result = runCli(["v1.2.3", "--root", dir]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Plain substring check — no regex, so no escaping of the version is needed.
  assert.ok(result.stdout.includes("match v1.2.3"), result.stdout);
});

// And the repo as it actually stands: a development tree must NOT satisfy a
// release build gate, whatever tag it is handed. That is not a limitation of
// the test — it is the gate doing its job on the state `main` is in between
// releases, and it is why the passing case above needs a fixture.
test("CLI exits 1 on a development tree, whatever tag it is given", () => {
  const result = runCli([`v${REPO_VERSION.replace("-dev", "")}`]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /::error::/);
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

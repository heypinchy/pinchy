/**
 * Pins pre-release.yml's moving-tag derivation to its single source of truth.
 *
 * The workflow must NOT re-inline the `main → next` / `release/X.Y → rc-X.Y`
 * bash: a second copy is free to drift from `movingTagForRef`, and staging pins
 * whatever tag the workflow actually pushes. So the "Choose moving tag" step
 * calls `scripts/moving-tag.mjs`, and this guard checks both halves — the
 * workflow invokes the wrapper, and the wrapper emits exactly what the unit-
 * tested function returns.
 *
 * Sibling of ci-image-tags.test.mjs: keep the workflow and the logic from
 * silently diverging.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { movingTagForRef } from "./release-logic.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "pre-release.yml");
const WRAPPER = join(ROOT, "scripts", "moving-tag.mjs");

/** Runs the wrapper with GITHUB_OUTPUT redirected to a temp file; returns its `moving=` value. */
function runWrapper(refName) {
  const outFile = join(mkdtempSync(join(tmpdir(), "moving-tag-")), "out");
  execFileSync("node", [WRAPPER, refName], {
    env: { ...process.env, GITHUB_OUTPUT: outFile },
    encoding: "utf8",
  });
  const line = readFileSync(outFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith("moving="));
  assert.ok(line, `wrapper wrote no moving= line for ${refName}`);
  return line.slice("moving=".length);
}

test("the workflow invokes the wrapper, not a re-inlined bash copy", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  assert.match(
    yaml,
    /run:\s*node scripts\/moving-tag\.mjs "\$GITHUB_REF_NAME"/,
    "the 'Choose moving tag' step must call scripts/moving-tag.mjs so the derivation stays single-source",
  );
});

test("the wrapper's output matches movingTagForRef for main and a release branch", () => {
  for (const ref of ["main", "release/0.9", "release/0.10"]) {
    assert.equal(
      runWrapper(ref),
      movingTagForRef(ref),
      `wrapper and movingTagForRef disagree for ${ref}`,
    );
  }
});

/**
 * Pins the concurrency groups that keep two publishing runs off the same
 * mutable Docker tag.
 *
 * `release.yml` and `pre-release.yml` both push to GHCR, and both push tags
 * that MOVE: `:latest` and `vX.Y.Z` from the release workflow, `:next` /
 * `rc-X.Y` from the pre-release one. Two runs pushing the same moving tag
 * concurrently can overtake each other — the slower build wins, and the tag
 * ends up pointing at the older image. Nothing reports that; it is discovered
 * by a user who pulled `:latest` and got the previous version.
 *
 * The two workflows need DIFFERENT keys, and that asymmetry is the whole
 * reason this guard exists:
 *
 * - **release.yml must be keyed on a constant.** `:latest` is one resource
 *   for the entire repository, so every release run competes with every other
 *   release run. Keying on `${{ github.ref }}` looks right and serializes
 *   almost nothing: a tag push carries `refs/tags/vX.Y.Z`, so two tags pushed
 *   in quick succession land in two different groups and race on `:latest`
 *   exactly as they did before. A `workflow_dispatch` republish is worse — it
 *   names its tag in an *input* (`inputs.tag`, which is why the checkout step
 *   reads it) and runs from `refs/heads/main`, so a per-ref group would never
 *   pair it with any tag push, including a republish of the very tag that is
 *   still building.
 *
 * - **pre-release.yml must be keyed on the ref.** Its moving tag is derived
 *   per branch (`movingTagForRef`: main → `next`, release/X.Y → `rc-X.Y`), so
 *   the branch IS the resource: two pushes to one branch must queue, two
 *   release branches must not wait on each other. A constant group there
 *   would serialize builds that can never collide.
 *
 * Sibling of ci-image-tags.test.mjs and moving-tag-workflow.test.mjs: keep a
 * workflow and the invariant it encodes from silently diverging.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE = join(ROOT, ".github", "workflows", "release.yml");
const PRE_RELEASE = join(ROOT, ".github", "workflows", "pre-release.yml");

/** Strips `#` comments so a commented-out example can never satisfy a check. */
function uncommented(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

/**
 * Reads the workflow-level `concurrency:` block.
 *
 * Deliberately anchored at column 0: a `concurrency:` nested inside a job
 * governs that job alone and would leave the other jobs — including the
 * Docker pushes — unserialized.
 */
function readConcurrency(path) {
  const yaml = uncommented(path);
  const match = yaml.match(/^concurrency:\n((?: {2}.*\n?)+)/m);
  assert.ok(
    match,
    `${path} must declare a workflow-level (column-0) concurrency block — a job-level one leaves the other jobs racing.`,
  );
  const group = match[1].match(/^ {2}group:\s*(.+?)\s*$/m);
  const cancel = match[1].match(/^ {2}cancel-in-progress:\s*(.+?)\s*$/m);
  assert.ok(group, `${path}'s concurrency block must set a group.`);
  return { group: group[1], cancelInProgress: cancel ? cancel[1] : undefined };
}

// Corpus assertion. Every check below is about GHCR pushes; if a workflow
// stops pushing, the guard is asserting something about a file that no longer
// does the dangerous thing, and would pass for the wrong reason.
test("both workflows really do push images to GHCR", () => {
  for (const path of [RELEASE, PRE_RELEASE]) {
    const yaml = uncommented(path);
    assert.match(
      yaml,
      /push:\s*true/,
      `${path} was expected to push a Docker image; if that changed, revisit this guard rather than deleting it.`,
    );
    assert.match(yaml, /ghcr\.io\//, `${path} was expected to target GHCR.`);
  }
});

test("release.yml's concurrency group is a constant, not keyed on the ref", () => {
  const { group } = readConcurrency(RELEASE);
  assert.ok(
    !group.includes("${{"),
    `release.yml's concurrency group must be a constant, got "${group}". ` +
      "`:latest` is one resource for the whole repository, so every release run competes with every other one. " +
      "A group containing ${{ github.ref }} puts two tags pushed in quick succession into two different groups — " +
      "they race on `:latest` exactly as if there were no concurrency block at all — and a workflow_dispatch " +
      "republish (which runs from a branch and names its tag in inputs.tag) never shares a group with any tag push.",
  );
  assert.ok(
    group.length > 0,
    "release.yml's concurrency group must not be empty.",
  );
});

test("pre-release.yml's concurrency group is keyed on the ref", () => {
  const { group } = readConcurrency(PRE_RELEASE);
  assert.match(
    group,
    /\$\{\{\s*github\.ref\s*\}\}/,
    `pre-release.yml's concurrency group must contain \${{ github.ref }}, got "${group}". ` +
      "Its moving tag is derived per branch (main → :next, release/X.Y → rc-X.Y), so the branch is the contended " +
      "resource: two pushes to one branch must queue, two release branches must never wait on each other.",
  );
});

test("neither workflow cancels a publish in flight", () => {
  for (const path of [RELEASE, PRE_RELEASE]) {
    assert.equal(
      readConcurrency(path).cancelInProgress,
      "false",
      `${path} must set cancel-in-progress: false. Cancelling a run mid-push leaves a half-published set of ` +
        "images — some tags moved, some not — which is worse than the race this serializes away.",
    );
  }
});

// The groups are plain strings in one repository-wide namespace. If they ever
// collided, a pre-release build would block a release (and vice versa) for no
// reason — the two touch disjoint tags.
test("the two groups can never collide", () => {
  const release = readConcurrency(RELEASE).group;
  const preRelease = readConcurrency(PRE_RELEASE).group;
  // github.ref always renders non-empty, so equality can only come from the
  // literal prefixes — compare those.
  const preReleasePrefix = preRelease.slice(0, preRelease.indexOf("${{"));
  assert.notEqual(
    release,
    preReleasePrefix,
    `release.yml's group ("${release}") must differ from pre-release.yml's ("${preRelease}") — ` +
      "concurrency groups share one namespace across the repository.",
  );
});

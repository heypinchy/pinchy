import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trackedRootFiles } from "./tracked-files.mjs";

/**
 * A guard that enumerates the repo with readdirSync also reads files git does
 * not track — and then asserts things about a developer's private state.
 *
 * The concrete case: dev-stack-port-isolation's band check picked up a
 * gitignored `docker-compose.local.yml` and failed on the host port it binds.
 * Two things make that worse than a cosmetic false positive:
 *
 *   1. The remedy it prints is impossible. "Add it to RESERVED_PORTS in
 *      worktree-ports.mjs" means committing one developer's local port choice
 *      into the list every worktree allocates against. The assertion cannot be
 *      discharged correctly, so the only way out is to ignore it.
 *   2. It is red LOCALLY and green in CI, where the file does not exist. That
 *      teaches "local red is normal, CI will tell me" — and a gate people
 *      routinely look past has stopped being a gate.
 *
 * The test's own name says "no hard-coded port IN THE REPO". A gitignored file
 * is not in the repo; git decides that question, not readdir.
 */
describe("listing the root files git actually tracks", () => {
  /** A throwaway repo, so the assertions are about git and not about ours. */
  function makeRepo() {
    const repo = mkdtempSync(join(tmpdir(), "pinchy-tracked-probe-"));
    execFileSync("git", [
      "-c",
      "init.defaultBranch=main",
      "init",
      "--quiet",
      repo,
    ]);
    for (const [key, value] of [
      ["user.email", "probe@example.com"],
      ["user.name", "Probe"],
      ["commit.gpgsign", "false"],
    ]) {
      execFileSync("git", ["config", key, value], { cwd: repo });
    }
    return repo;
  }

  test("includes a tracked file", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repo });

    assert.deepEqual(trackedRootFiles(repo), ["docker-compose.yml"]);
  });

  // The regression itself: the file exists on disk and readdir would return it.
  test("excludes a gitignored file that is really on disk", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "docker-compose.local.yml\n");
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repo });
    writeFileSync(join(repo, "docker-compose.local.yml"), "services: {}\n");

    const files = trackedRootFiles(repo);
    assert.ok(files.includes("docker-compose.yml"));
    assert.ok(
      !files.includes("docker-compose.local.yml"),
      `a gitignored file is a developer's own business, not the repo's: ${files.join(", ")}`,
    );
  });

  // An untracked-but-not-ignored file is the same case: it is not in the repo,
  // so a guard asserting about "the repo" must not read it.
  test("excludes a file that is merely untracked", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repo });
    writeFileSync(join(repo, "docker-compose.scratch.yml"), "services: {}\n");

    assert.deepEqual(trackedRootFiles(repo), ["docker-compose.yml"]);
  });

  // Only the root. A guard that globs `docker-compose*` at the root must not
  // silently start matching a nested file of the same name.
  test("does not descend into subdirectories", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    // Tracked, same name, one level down: `git ls-files` lists it recursively,
    // so the filtering is the helper's job and not git's.
    writeFileSync(join(repo, "sub", "docker-compose.yml"), "services: {}\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repo });

    assert.deepEqual(trackedRootFiles(repo), ["docker-compose.yml"]);
  });

  /**
   * Fail OPEN, and the direction is deliberate: a guard may check too much,
   * never too little. If git cannot answer, the caller falls back to reading
   * the directory — which is the behaviour that shipped before this helper.
   * Returning [] here would silently empty the corpus and turn the guard green
   * forever, which is the failure this repo cares about most.
   */
  test("answers null when git cannot enumerate, never an empty list", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "pinchy-tracked-norepo-"));
    assert.equal(trackedRootFiles(notARepo), null);
  });
});

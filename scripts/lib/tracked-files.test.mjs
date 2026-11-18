import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trackedFilesIn } from "./tracked-files.mjs";

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
describe("listing the files git actually tracks in a directory", () => {
  const made = [];
  after(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A throwaway repo, so the assertions are about git and not about ours.
   *
   * No commit anywhere in this file, deliberately: `git ls-files` reads the
   * INDEX, so `git add` is the whole of "tracked" as far as this helper is
   * concerned, and a commit would test nothing while pulling in a user
   * identity, a gpg setting, and whatever `core.hooksPath` the developer has
   * set globally.
   */
  function makeRepo() {
    const repo = mkdtempSync(join(tmpdir(), "pinchy-tracked-probe-"));
    made.push(repo);
    execFileSync("git", [
      "-c",
      "init.defaultBranch=main",
      "init",
      "--quiet",
      repo,
    ]);
    return repo;
  }

  /** Stage everything — the index is what `git ls-files` reports. */
  const stage = (repo) => execFileSync("git", ["add", "-A"], { cwd: repo });

  test("includes a tracked file", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    stage(repo);

    assert.deepEqual(trackedFilesIn(repo), ["docker-compose.yml"]);
  });

  // The regression itself: the file exists on disk and readdir would return it.
  test("excludes a gitignored file that is really on disk", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "docker-compose.local.yml\n");
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    stage(repo);
    writeFileSync(join(repo, "docker-compose.local.yml"), "services: {}\n");

    const files = trackedFilesIn(repo);
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
    stage(repo);
    writeFileSync(join(repo, "docker-compose.scratch.yml"), "services: {}\n");

    assert.deepEqual(trackedFilesIn(repo), ["docker-compose.yml"]);
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
    stage(repo);

    assert.deepEqual(trackedFilesIn(repo), ["docker-compose.yml"]);
  });

  /**
   * "Root" means the directory you pass, not the repository's top level. The
   * port guard enumerates two of them — the repo root for compose files and
   * `packages/web` for Playwright configs — and the second only works because
   * `git ls-files` reports paths relative to its cwd rather than to the repo.
   * Asserted rather than assumed: the alternative spelling (`--full-name`)
   * would return `packages/web/playwright.config.ts`, which the root filter
   * then drops, silently emptying the corpus.
   */
  test("enumerates a subdirectory relative to that subdirectory", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "web"));
    writeFileSync(join(repo, "root-only.yml"), "services: {}\n");
    writeFileSync(join(repo, "web", "playwright.config.ts"), "export {};\n");
    mkdirSync(join(repo, "web", "e2e"));
    writeFileSync(join(repo, "web", "e2e", "deep.config.ts"), "export {};\n");
    stage(repo);

    assert.deepEqual(trackedFilesIn(join(repo, "web")), [
      "playwright.config.ts",
    ]);
  });

  /**
   * The failure this helper must not have. Node's default `maxBuffer` is 1 MB;
   * `git ls-files -z` here is already 115 KB and grows with the repo. Past the
   * limit execFileSync throws ENOBUFS, the catch below turns that into `null`,
   * the caller falls back to readdirSync — and the very bug this helper exists
   * to fix is back, silently, on the day the repo gets big enough.
   *
   * 6000 files is a fraction of a second and clears 1 MB; `docs-required`
   * already sets an explicit maxBuffer for the same reason.
   */
  test("survives an output larger than the default 1 MB buffer", () => {
    const repo = makeRepo();
    const padding = "p".repeat(200);
    for (let i = 0; i < 6000; i++) {
      writeFileSync(join(repo, `${i}-${padding}.yml`), "x");
    }
    stage(repo);

    const files = trackedFilesIn(repo);
    assert.ok(
      files !== null,
      "git could not be read and the caller would fall back to readdirSync — " +
        "raise maxBuffer instead of letting the corpus quietly change source",
    );
    assert.equal(files.length, 6000);
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
    made.push(notARepo);
    assert.equal(trackedFilesIn(notARepo), null);
  });
});

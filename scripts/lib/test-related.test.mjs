import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toVitestPaths, collectChangedFiles } from "./test-related.mjs";

const RUNNER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-related.mjs",
);

/**
 * `vitest related` resolves its arguments against the vitest root, which is
 * packages/web — but the paths a user or `git diff` produces are relative to the
 * REPO root. Handing the latter straight through silently matches nothing and
 * reports "no test files found", which reads like "nothing to run" rather than
 * "you passed the wrong shape". That mistranslation is the whole job here.
 */
describe("translating repo-relative paths for vitest related", () => {
  test("rebases a web source file onto the vitest root", () => {
    assert.deepEqual(toVitestPaths(["packages/web/src/lib/audit.ts"]), [
      "src/lib/audit.ts",
    ]);
  });

  // The web vitest config includes ../plugins/pinchy-*, so a plugin edit has
  // real tests in this runner and must survive the translation.
  test("keeps plugin files reachable from the vitest root", () => {
    assert.deepEqual(
      toVitestPaths(["packages/plugins/pinchy-files/pdf-extract.ts"]),
      ["../plugins/pinchy-files/pdf-extract.ts"],
    );
  });

  // The web-relative form of the same file: what you get by copying a path out
  // of a vitest failure, or by running from inside packages/web. Accepting the
  // repo-relative spelling but not this one drops a real target and says
  // "nothing to run", which is the silent miss this module exists to prevent.
  test("accepts the plugin path already spelled from the vitest root", () => {
    assert.deepEqual(
      toVitestPaths(["../plugins/pinchy-files/pdf-extract.ts"]),
      ["../plugins/pinchy-files/pdf-extract.ts"],
    );
  });

  test("passes a path that is already web-relative through unchanged", () => {
    // Someone running this from inside packages/web out of habit.
    assert.deepEqual(toVitestPaths(["src/lib/audit.ts"]), ["src/lib/audit.ts"]);
  });

  // Everything else genuinely has no tests in this runner. Dropping it is right;
  // passing it through would make vitest report a miss and hide the real hits.
  for (const path of [
    "docs/guides/agents.md",
    "scripts/lib/ci-path-filter.mjs",
    "AGENTS.md",
    "docker-compose.yml",
    ".github/workflows/ci.yml",
  ]) {
    test(`drops ${path} — nothing in the web runner covers it`, () => {
      assert.deepEqual(toVitestPaths([path]), []);
    });
  }

  test("keeps the order and drops duplicates", () => {
    assert.deepEqual(
      toVitestPaths([
        "packages/web/src/b.ts",
        "docs/x.md",
        "packages/web/src/a.ts",
        "packages/web/src/b.ts",
      ]),
      ["src/b.ts", "src/a.ts"],
    );
  });

  test("ignores blank lines from a git diff", () => {
    assert.deepEqual(toVitestPaths(["", "  ", "packages/web/src/a.ts"]), [
      "src/a.ts",
    ]);
  });

  test("returns nothing for an empty change set", () => {
    assert.deepEqual(toVitestPaths([]), []);
  });

  // `vitest related` walks the module graph, so only files that can BE a module
  // are useful arguments. A changed package.json or migration lives under
  // packages/web and really exists, so nothing above rejects it — and vitest
  // then reports "no test files found" and exits non-zero, turning a run that
  // had real targets into a spurious red.
  for (const path of [
    "packages/web/package.json",
    "packages/web/drizzle/0054_pgvector.sql",
    "packages/web/public/logo.svg",
    "packages/web/README.md",
    "packages/web/.env.example",
  ]) {
    test(`drops ${path} — not a module vitest can trace`, () => {
      assert.deepEqual(toVitestPaths([path]), []);
    });
  }

  test("keeps every script extension the runner can trace", () => {
    const sources = [
      "packages/web/src/a.ts",
      "packages/web/src/b.tsx",
      "packages/web/src/c.js",
      "packages/web/src/d.jsx",
      "packages/web/src/e.mts",
    ];
    assert.equal(toVitestPaths(sources).length, sources.length);
  });

  // A deleted file cannot be imported by anything, and handing it to vitest
  // makes the run error instead of testing the files that DO still exist.
  test("skips paths the caller marked as deleted", () => {
    assert.deepEqual(
      toVitestPaths(["packages/web/src/gone.ts"], {
        exists: (p) => !p.endsWith("gone.ts"),
      }),
      [],
    );
  });
});

/**
 * WHICH change set. A tool whose value is "runs the tests for what you changed"
 * has to agree with the user about what "changed" means, and the working tree
 * alone does not: the moment you commit, `git diff HEAD` is empty and the tool
 * reports that nothing changed — a zero-test run, exit 0, on the branch you are
 * about to push. That is the same failure shape as the mistranslation above, and
 * worse, because it arrives exactly when you are trying to verify a commit.
 */
describe("deciding which files count as changed", () => {
  const WORKING_TREE = "diff --name-only -z HEAD";
  const UNTRACKED = "ls-files --others --exclude-standard -z";
  const MERGE_BASE = "merge-base origin/main HEAD";

  /** A git that answers only the calls it was given, and throws otherwise. */
  function gitStub(answers) {
    return (args) => {
      const key = args.join(" ");
      if (!(key in answers)) throw new Error(`unexpected: git ${key}`);
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return answer;
    };
  }

  test("reads the working tree, tracked and untracked", () => {
    const files = collectChangedFiles(
      gitStub({
        [WORKING_TREE]: "packages/web/src/edited.ts\0",
        [UNTRACKED]: "packages/web/src/brand-new.ts\0",
        [MERGE_BASE]: "abc123\n",
        "diff --name-only -z abc123 HEAD": "",
      }),
    );
    assert.deepEqual(files.filter(Boolean), [
      "packages/web/src/edited.ts",
      "packages/web/src/brand-new.ts",
    ]);
  });

  // The regression this exists for: everything committed, working tree clean.
  test("includes files changed by commits on this branch", () => {
    const files = collectChangedFiles(
      gitStub({
        [WORKING_TREE]: "",
        [UNTRACKED]: "",
        [MERGE_BASE]: "abc123\n",
        "diff --name-only -z abc123 HEAD": "packages/web/src/committed.ts\0",
      }),
    );
    assert.deepEqual(files.filter(Boolean), ["packages/web/src/committed.ts"]);
  });

  // Fail open, like the lock: a change set we can only read half of is still a
  // useful answer, and refusing to run any tests is the worse outcome.
  test("still reports the working tree when the base ref is unknown", () => {
    const files = collectChangedFiles(
      gitStub({
        [WORKING_TREE]: "packages/web/src/edited.ts\0",
        [UNTRACKED]: "",
        [MERGE_BASE]: new Error("fatal: Not a valid object name origin/main"),
      }),
    );
    assert.deepEqual(files.filter(Boolean), ["packages/web/src/edited.ts"]);
  });

  // No merge-base output at all (a repo with no commits): same rule, do not
  // hand git an empty revision and turn a readable half into an error.
  test("skips the branch range when there is no merge base", () => {
    const files = collectChangedFiles(
      gitStub({ [WORKING_TREE]: "", [UNTRACKED]: "", [MERGE_BASE]: "\n" }),
    );
    assert.deepEqual(files.filter(Boolean), []);
  });

  test("propagates a git that does not work at all", () => {
    // Distinct from "no base ref": the caller must be able to tell the user.
    assert.throws(() =>
      collectChangedFiles(
        gitStub({ [WORKING_TREE]: new Error("git: command not found") }),
      ),
    );
  });

  /**
   * The stubs above pin the call shapes; this pins that real git answers them the
   * way we think. It is the whole point of the change — a committed file must
   * appear — and a stub can agree with a wrong assumption forever.
   */
  test("finds a committed file in a real repository", () => {
    const repo = mkdtempSync(join(tmpdir(), "pinchy-related-probe-"));
    const git = (args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    execFileSync(
      "git",
      ["-c", "init.defaultBranch=main", "init", "--quiet", repo],
      { encoding: "utf8" },
    );
    for (const [key, value] of [
      ["user.email", "probe@example.com"],
      ["user.name", "Probe"],
      ["commit.gpgsign", "false"],
    ]) {
      git(["config", key, value]);
    }
    writeFileSync(join(repo, "base.ts"), "export const a = 1;\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "base"]);
    git(["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(repo, "committed.ts"), "export const b = 2;\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "work"]);
    writeFileSync(join(repo, "dirty.ts"), "export const c = 3;\n");

    const files = collectChangedFiles(git, { baseRef: "main" }).filter(Boolean);
    assert.deepEqual(files.sort(), ["committed.ts", "dirty.ts"]);
    // The base commit's own file is not part of this branch's change set.
    assert.ok(!files.includes("base.ts"));
  });
});

/**
 * The two "nothing to run" outcomes are not the same outcome, and the exit code
 * is the only place that difference reaches a shell.
 *
 * With no arguments, an empty result means the change set holds nothing this
 * runner covers — a docs-only branch. Nothing ran and nothing should have: 0.
 *
 * With arguments, the caller ASSERTED those files. An empty result means the
 * assertion did not hold — a typo, a deleted path, a shape the translation
 * drops — and exiting 0 there is precisely the failure this module's header
 * calls worse than an error, because it looks exactly like a pass. It is
 * reachable from a documented command (`pnpm test:related <file>`) and it
 * survives `&&`.
 *
 * Probed by running the real script: the exit code is the behaviour under test,
 * and a unit test of the translation cannot see it.
 */
describe("what the runner reports when it runs no tests", () => {
  /** Never resolves to a file, so the run ends before vitest is spawned. */
  const NO_SUCH_FILE = "packages/web/src/does-not-exist-probe.ts";

  function runRunner(args) {
    return spawnSync(process.execPath, [RUNNER, ...args], {
      encoding: "utf8",
    });
  }

  test("fails when the files you named match nothing", () => {
    const { status, stderr } = runRunner([NO_SUCH_FILE]);
    assert.equal(
      status,
      1,
      `naming files that match nothing must not read as a pass:\n${stderr}`,
    );
  });

  test("says why nothing matched, including the path that did not exist", () => {
    const { stderr } = runRunner([NO_SUCH_FILE]);
    // The message has to carry the offending path: "none of those paths" alone
    // leaves a typo indistinguishable from a file that genuinely has no tests.
    assert.match(stderr, /does-not-exist-probe\.ts/);
  });

  // A path this runner legitimately does not cover is still a request that ran
  // no tests. Same rule: the caller asked, and nothing happened.
  test("fails for a named path the web runner does not cover", () => {
    const { status } = runRunner(["scripts/lib/ci-path-filter.mjs"]);
    assert.equal(status, 1);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import {
  catchAllCommands,
  validateCatchAllCommand,
  binDirsFor,
  resolveBinary,
  requiredBinaries,
  parseInvocation,
  allToolingRequirements,
  formatMissingToolingMessage,
} from "./precommit-tooling.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const ROOT_PACKAGE_JSON = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
);

const GOOD_CONFIG = {
  "packages/web/src/**/*.{ts,tsx}": [
    "pnpm -C packages/web exec eslint --no-warn-ignored",
  ],
  "*": ["prettier --write --ignore-unknown"],
};

test("catchAllCommands finds the whole-tree rule", () => {
  assert.deepEqual(catchAllCommands(GOOD_CONFIG), [
    "prettier --write --ignore-unknown",
  ]);
});

test("catchAllCommands accepts the other whole-tree spellings and a bare string", () => {
  assert.deepEqual(catchAllCommands({ "**/*": "prettier --write" }), [
    "prettier --write",
  ]);
  assert.deepEqual(catchAllCommands({ "**": ["prettier --write"] }), [
    "prettier --write",
  ]);
});

test("catchAllCommands reports nothing when every rule is scoped to a subtree", () => {
  // The narrowing this guard exists for: a config that only ever looks at
  // packages/web leaves scripts/, config/, docs/ and the plugins unformatted on
  // commit while the hook still reports green.
  assert.deepEqual(
    catchAllCommands({
      "packages/web/src/**/*.{ts,tsx}": ["prettier --write"],
    }),
    [],
  );
});

test("validateCatchAllCommand accepts a directly-invoked binary", () => {
  assert.deepEqual(
    validateCatchAllCommand("prettier --write --ignore-unknown"),
    [],
  );
});

test("validateCatchAllCommand rejects `pnpm exec` — it needs a node_modules the worktree does not have", () => {
  // This is #838's proposed fix, and it is the opposite of one: a git worktree
  // has no node_modules of its own, so `pnpm exec` fails there with
  // ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL while the bare binary still resolves
  // through the ancestor walk into the main checkout.
  const problems = validateCatchAllCommand(
    "pnpm exec prettier --write --ignore-unknown",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /worktree/i);
});

test("validateCatchAllCommand rejects the other package-manager wrappers", () => {
  for (const command of [
    "npx prettier --write",
    "pnpm -C packages/web exec eslint",
    "pnpm --filter @pinchy/web exec prettier --write",
    "npm exec prettier --write",
    "yarn prettier --write",
    "pnpm run format",
  ]) {
    assert.ok(
      validateCatchAllCommand(command).length > 0,
      `expected \`${command}\` to be rejected`,
    );
  }
});

test("binDirsFor models the ancestor walk lint-staged uses to build PATH", () => {
  // A worktree under .claude/worktrees/ has no node_modules of its own; the
  // binary it runs is the main checkout's, found by walking up.
  const dirs = binDirsFor("/repo/.claude/worktrees/feature-x");
  assert.deepEqual(dirs.slice(0, 4), [
    join("/repo/.claude/worktrees/feature-x", "node_modules", ".bin"),
    join("/repo/.claude/worktrees", "node_modules", ".bin"),
    join("/repo/.claude", "node_modules", ".bin"),
    join("/repo", "node_modules", ".bin"),
  ]);
});

test("resolveBinary returns the first existing candidate, or null", () => {
  const exists = (p) => p === join("/repo", "node_modules", ".bin", "prettier");
  assert.equal(
    resolveBinary(
      "prettier",
      ["/a/node_modules/.bin", "/repo/node_modules/.bin"],
      exists,
    ),
    join("/repo", "node_modules", ".bin", "prettier"),
  );
  assert.equal(
    resolveBinary("eslint", ["/a/node_modules/.bin"], () => false),
    null,
  );
});

test("requiredBinaries covers lint-staged itself plus every whole-tree binary", () => {
  // `npx lint-staged` on a stale install does not fail — it silently reaches
  // for the network instead, which is worse than the ENOENT it replaces.
  assert.deepEqual(requiredBinaries(GOOD_CONFIG), ["lint-staged", "prettier"]);
});

test("parseInvocation unwraps the directory a package-manager wrapper runs in", () => {
  // A scoped rule legitimately uses `pnpm -C <dir> exec`, because the binary
  // lives in that package rather than at the root. To say anything useful about
  // it we have to look where pnpm would: <dir>/node_modules/.bin.
  assert.deepEqual(parseInvocation("prettier --write --ignore-unknown"), {
    binary: "prettier",
    dir: ".",
  });
  assert.deepEqual(
    parseInvocation("pnpm -C packages/web exec eslint --no-warn-ignored"),
    { binary: "eslint", dir: "packages/web" },
  );
  assert.deepEqual(parseInvocation("pnpm --dir packages/web exec tsc"), {
    binary: "tsc",
    dir: "packages/web",
  });
  assert.deepEqual(parseInvocation("pnpm exec prettier --write"), {
    binary: "prettier",
    dir: ".",
  });
  assert.deepEqual(parseInvocation("npx tsc --noEmit"), {
    binary: "tsc",
    dir: ".",
  });
});

test("parseInvocation gives up on a wrapper it cannot see through", () => {
  // `pnpm run <script>` resolves through another package.json; guessing would be
  // worse than saying nothing, because the explain path must never invent a
  // missing binary that is really a failing lint rule.
  assert.equal(parseInvocation("pnpm run format"), null);
  assert.equal(parseInvocation("pnpm --filter @pinchy/web exec eslint"), null);
});

test("allToolingRequirements covers the scoped rules too, with their directory", () => {
  assert.deepEqual(allToolingRequirements(GOOD_CONFIG), [
    { binary: "lint-staged", dir: "." },
    { binary: "eslint", dir: "packages/web" },
    { binary: "prettier", dir: "." },
  ]);
});

test("formatMissingToolingMessage names the fix and warns off --no-verify", () => {
  const message = formatMissingToolingMessage(["prettier"]);
  assert.match(message, /prettier/);
  assert.match(message, /pnpm install/);
  // --no-verify is the reflex this whole guard exists to prevent: it also skips
  // the drizzle-snapshot check and the absolute-path guard in the same hook.
  assert.match(message, /--no-verify/);
});

test("the root lint-staged config covers files outside packages/web/src", () => {
  const commands = catchAllCommands(ROOT_PACKAGE_JSON["lint-staged"]);
  assert.ok(
    commands.length > 0,
    "root package.json needs a whole-tree lint-staged rule; without it a commit " +
      "touching scripts/, config/, docs/ or the plugins is formatted by nothing",
  );
  for (const command of commands) {
    assert.deepEqual(validateCatchAllCommand(command), []);
  }
});

test("the pre-commit hook checks its tooling before it runs lint-staged", () => {
  // Comments are stripped first: a commented-out step leaves the substring in
  // the file while the hook stops running it, and the prose above each step
  // legitimately names the other one.
  const hook = readFileSync(join(REPO_ROOT, ".husky/pre-commit"), "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
  const preflight = hook.indexOf("scripts/check-precommit-tooling.mjs");
  const lintStaged = hook.indexOf("npx lint-staged");
  assert.ok(preflight >= 0, ".husky/pre-commit must run the tooling preflight");
  assert.ok(lintStaged >= 0, ".husky/pre-commit must run lint-staged");
  assert.ok(
    preflight < lintStaged,
    "the preflight must run first — its whole point is to replace lint-staged's " +
      "ENOENT with an instruction",
  );
  // The scoped rules can only be judged after the fact: whether they run at all
  // depends on what is staged, so blocking on them up front would reject a docs
  // commit for a binary it never invokes.
  assert.ok(
    hook.indexOf("--explain") > lintStaged,
    ".husky/pre-commit must explain a lint-staged failure afterwards, so a " +
      "missing per-package binary reads as `pnpm install` rather than as a lint error",
  );
});

test("the whole-tree command really formats a file outside packages/web/src", () => {
  // The end-to-end half, and the only half that can see a stale install: it
  // resolves and runs the configured binary exactly as lint-staged does, from a
  // directory with no node_modules of its own (the worktree case), on a file
  // that no packages/web-scoped rule would ever match.
  //
  // The probe dir lives inside the repo (the ancestor walk is the whole point)
  // and is deliberately NOT gitignored: prettier reads the root .gitignore, and
  // it skips an ignored path even when that path is passed explicitly — so an
  // entry here would turn `--write` into a no-op. The content assertion below
  // catches that, but only after the "obvious" cleanup has already been made.
  const probeDir = mkdtempSync(join(REPO_ROOT, ".precommit-probe-"));
  try {
    const probeFile = join(probeDir, "probe.js");
    writeFileSync(probeFile, "const   a =   1\n");

    const [command] = catchAllCommands(ROOT_PACKAGE_JSON["lint-staged"]);
    const [binary, ...args] = command.split(/\s+/).filter(Boolean);
    const binDirs = binDirsFor(probeDir);
    const resolved = resolveBinary(binary, binDirs);
    assert.ok(
      resolved,
      `\`${binary}\` does not resolve from ${probeDir}; run \`pnpm install\``,
    );

    const result = spawnSync(resolved, [...args, probeFile], {
      cwd: probeDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [...binDirs, process.env.PATH ?? ""].join(delimiter),
      },
    });
    assert.equal(
      result.status,
      0,
      `${command} failed: ${result.stderr || result.stdout}`,
    );
    assert.equal(readFileSync(probeFile, "utf8"), "const a = 1;\n");
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test("the preflight itself runs clean, and says nothing, on an installed checkout", () => {
  // Nothing but the hook executes check-precommit-tooling.mjs, and the hook runs
  // it at commit time — where a bad import or a stray console.log reads as "the
  // pre-commit hook is broken" and produces exactly the --no-verify this guard
  // exists to prevent. Both modes must therefore be silent when there is nothing
  // to report, and `--explain` must stay exit 0 even so: it is a post-mortem for
  // a failure the hook has already decided about.
  const script = join(REPO_ROOT, "scripts/check-precommit-tooling.mjs");
  for (const args of [[], ["--explain"]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const invocation = ["check-precommit-tooling.mjs", ...args].join(" ");
    assert.equal(
      result.status,
      0,
      `${invocation} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
    assert.equal(
      `${result.stdout}${result.stderr}`.trim(),
      "",
      `${invocation} must be silent when every binary resolves`,
    );
  }
});

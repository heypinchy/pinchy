import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import prettier from "prettier";
import {
  validateFormatScripts,
  validatePrettierOwnership,
  validateCiWiring,
} from "./format-gate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const GOOD_SCRIPTS = {
  format: "prettier --write .",
  "format:check": "prettier --check .",
};

// One file per tree that lived outside the old packages/web-only gate, plus one
// that lived inside it. Every entry is load-bearing: drop `config/` here and a
// `config/` line in .prettierignore stops being a test failure.
const MUST_BE_COVERED = [
  "scripts/lib/ci-path-filter.mjs",
  "scripts/release.mjs",
  "packages/web/src/lib/audit.ts",
  "packages/plugins/pinchy-odoo/index.ts",
  "config/odoo-mock/server.js",
  "docs/scripts/check-no-tables-in-lists.mjs",
  "docs/src/content/docs/index.mdx",
  ".github/workflows/ci.yml",
  "docker-compose.yml",
];

test("validateFormatScripts accepts the whole-tree form", () => {
  assert.deepEqual(validateFormatScripts(GOOD_SCRIPTS), []);
});

test("validateFormatScripts accepts extra flags around the whole-tree target", () => {
  // The rule is about SCOPE, not about banning flags. `--cache` is a plain perf
  // win and must not require touching this guard.
  assert.deepEqual(
    validateFormatScripts({
      ...GOOD_SCRIPTS,
      "format:check": "prettier --check . --cache",
    }),
    [],
  );
});

test("validateFormatScripts flags a glob list — the exact shape that hid scripts/ for months", () => {
  // The pre-2026-07 gate was `prettier --check` against a hand-written list of
  // globs. Every directory nobody thought to add (scripts/, config/, the
  // plugins) was silently outside it while the check reported green.
  const problems = validateFormatScripts({
    ...GOOD_SCRIPTS,
    "format:check": 'prettier --check "packages/web/**" "docs/src/**"',
  });
  assert.ok(
    problems.some((p) => /format:check/.test(p) && /whole tree|`\.`/.test(p)),
    `expected a scope problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateFormatScripts flags delegation to a single package", () => {
  // `pnpm --filter @pinchy/web format:check` is what CI ran before: a check
  // named "Format check" that only ever read one package.
  const problems = validateFormatScripts({
    ...GOOD_SCRIPTS,
    "format:check": "pnpm --filter @pinchy/web format:check",
  });
  assert.ok(
    problems.some((p) => /prettier/.test(p)),
    `expected a direct-invocation problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateFormatScripts flags a missing script", () => {
  assert.equal(
    validateFormatScripts({ format: "prettier --write ." }).length,
    1,
  );
});

test("validateFormatScripts flags a check script that would rewrite files", () => {
  // `--write` in the CI script means the gate mutates the checkout and passes.
  const problems = validateFormatScripts({
    ...GOOD_SCRIPTS,
    "format:check": "prettier --write .",
  });
  assert.ok(
    problems.some((p) => /--check/.test(p)),
    `expected a --check problem, got ${JSON.stringify(problems)}`,
  );
});

test("validatePrettierOwnership accepts prettier declared once, at the root", () => {
  assert.deepEqual(
    validatePrettierOwnership([{ path: "package.json", version: "^3.9.5" }]),
    [],
  );
});

test("validatePrettierOwnership flags a second declaration", () => {
  // Two prettier versions = two verdicts on the same file. Whichever the gate
  // resolves, a contributor running the other one produces a diff CI rejects.
  const problems = validatePrettierOwnership([
    { path: "package.json", version: "^3.9.5" },
    { path: "packages/web/package.json", version: "^3.4.0" },
  ]);
  assert.ok(
    problems.some((p) => /packages\/web\/package\.json/.test(p)),
    `expected a duplicate-declaration problem, got ${JSON.stringify(problems)}`,
  );
});

test("validatePrettierOwnership flags prettier missing from the root", () => {
  const problems = validatePrettierOwnership([
    { path: "packages/web/package.json", version: "^3.9.5" },
  ]);
  assert.ok(
    problems.some((p) => /root/.test(p)),
    `expected a root-ownership problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateCiWiring flags a commented-out gate", () => {
  // Same trap as the typecheck guard: the substring survives in the file while
  // CI stops running it.
  const problems = validateCiWiring(
    "jobs:\n  quality:\n    steps:\n      # run: pnpm format:check",
  );
  assert.equal(problems.length, 1);
});

// --- Real wiring, not fixtures ------------------------------------------------

test("the repo's root package.json declares the whole-tree format scripts", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(validateFormatScripts(pkg.scripts ?? {}), []);
});

test("prettier is owned by exactly one package.json — the root one", () => {
  const files = execFileSync(
    "git",
    ["ls-files", "package.json", "*/package.json", "**/package.json"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const declarations = [];
  for (const path of files) {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
    const version = pkg.devDependencies?.prettier ?? pkg.dependencies?.prettier;
    if (version) declarations.push({ path, version });
  }
  assert.deepEqual(validatePrettierOwnership(declarations), []);
});

test("CI runs the root format gate", () => {
  const ci = readFileSync(
    join(REPO_ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.deepEqual(validateCiWiring(ci), []);
});

// The assertion that actually pins COVERAGE. The three checks above prove the
// gate is wired and whole-tree; this one proves the ignore rules don't quietly
// carve source back out of it. `.prettierignore` is the one place where a
// single well-meaning line ("scripts/ is just tooling") reverts this entire PR
// while every check stays green.
test("no ignore rule hides a tree the gate exists to cover", async () => {
  for (const path of MUST_BE_COVERED) {
    const info = await prettier.getFileInfo(join(REPO_ROOT, path), {
      ignorePath: [
        join(REPO_ROOT, ".gitignore"),
        join(REPO_ROOT, ".prettierignore"),
      ],
    });
    assert.equal(
      info.ignored,
      false,
      `${path} is excluded from the format gate`,
    );
    assert.notEqual(
      info.inferredParser,
      null,
      `${path} has no prettier parser — gate is a no-op`,
    );
  }
});

// The repo runs two styles: packages/** (printWidth 100, trailingComma es5) and
// prettier's defaults everywhere else. That split is fine right up until it cuts
// through code duplicated ON PURPOSE — `normalizeTableHtml` lives in both
// packages/plugins/pinchy-files and packages/web, and normalize-docx-table-html
// -drift.test.ts pins the two bodies to be identical modulo whitespace.
// `trailingComma` is a TOKEN, not whitespace, so a config that reaches only one
// of the two makes that guard red — which is exactly how this config ended up at
// packages/ instead of packages/web/. Pin it here, where the message can say so,
// rather than leaving a confusing drift failure as the only signal.
test("packages/web and packages/plugins resolve the same prettier config", async () => {
  const [web, plugins] = await Promise.all([
    prettier.resolveConfig(
      join(REPO_ROOT, "packages/web/src/hooks/use-ws-runtime.ts"),
    ),
    prettier.resolveConfig(
      join(REPO_ROOT, "packages/plugins/pinchy-files/docx-extract.ts"),
    ),
  ]);
  assert.notEqual(
    web,
    null,
    "packages/.prettierrc no longer governs packages/web",
  );
  assert.deepEqual(
    plugins,
    web,
    "the plugins and the web app must format identically — they share duplicated-by-design code",
  );
});

// The mirror image: the ignore rules must still hide GENERATED trees. Prettier
// reads only the ROOT .gitignore, so anything a nested one covers (docs/.astro,
// packages/web/eval/results) has to be repeated in .prettierignore or `pnpm
// format` reformats build output.
test("generated trees stay outside the gate", async () => {
  const mustBeIgnored = [
    "docs/.astro/content-modules.mjs",
    "packages/web/eval/results/anything.json",
    // Generated by next build/dev. Present locally, absent from a fresh CI
    // checkout — without a rule, the local gate reads a file CI never sees.
    "packages/web/next-env.d.ts",
    "pnpm-lock.yaml",
    "docs/pnpm-lock.yaml",
    "node_modules/whatever/index.js",
  ];
  for (const path of mustBeIgnored) {
    const info = await prettier.getFileInfo(join(REPO_ROOT, path), {
      ignorePath: [
        join(REPO_ROOT, ".gitignore"),
        join(REPO_ROOT, ".prettierignore"),
      ],
    });
    assert.equal(
      info.ignored,
      true,
      `${path} is generated but the format gate would rewrite it`,
    );
  }
});

// Guard the guard: the coverage probe above only means something if those paths
// exist. A renamed file would turn a real assertion into a vacuous one.
test("the coverage probe points at files that exist", () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).split("\n"),
  );
  for (const path of MUST_BE_COVERED) {
    assert.ok(
      tracked.has(path),
      `${path} no longer exists — update MUST_BE_COVERED`,
    );
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  validateTypecheckTsconfig,
  validateTypecheckScript,
  validateCiWiring,
} from "./web-typecheck-gate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = join(REPO_ROOT, "packages", "web");

// A tsconfig shape that satisfies the gate: it includes the web test files and
// re-excludes none of them.
const GOOD_TSCONFIG = {
  extends: "./tsconfig.json",
  include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.mts"],
  exclude: ["node_modules", "e2e"],
};

test("validateTypecheckTsconfig accepts a config that includes test files", () => {
  assert.deepEqual(validateTypecheckTsconfig(GOOD_TSCONFIG), []);
});

test("validateTypecheckTsconfig flags an include that misses src/**", () => {
  const problems = validateTypecheckTsconfig({ ...GOOD_TSCONFIG, include: ["next-env.d.ts"] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/\*\*/);
});

test("validateTypecheckTsconfig flags an exclude that drops *.test.ts", () => {
  // The trap this guard exists for: silently re-excluding test files turns the
  // gate back into a no-op for exactly the files it was added to protect.
  const problems = validateTypecheckTsconfig({
    ...GOOD_TSCONFIG,
    exclude: ["node_modules", "src/**/*.test.ts"],
  });
  assert.ok(
    problems.some((p) => /exclude/.test(p) && /\.test\./.test(p)),
    `expected a test-exclude problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateTypecheckTsconfig flags an exclude that drops __tests__/", () => {
  const problems = validateTypecheckTsconfig({
    ...GOOD_TSCONFIG,
    exclude: ["**/__tests__/**"],
  });
  assert.ok(problems.some((p) => /exclude/.test(p)));
});

test("validateTypecheckTsconfig reports a problem (not a throw) when config is not an object", () => {
  assert.ok(validateTypecheckTsconfig("oops").length > 0);
  assert.ok(validateTypecheckTsconfig(null).length > 0);
  assert.ok(validateTypecheckTsconfig([]).length > 0);
});

test("validateTypecheckScript accepts a script wired to the gate config", () => {
  assert.deepEqual(
    validateTypecheckScript({ scripts: { typecheck: "tsc --noEmit -p tsconfig.typecheck.json" } }),
    [],
  );
});

test("validateTypecheckScript flags a missing typecheck script", () => {
  const problems = validateTypecheckScript({ scripts: { build: "next build" } });
  assert.ok(problems.some((p) => /needs a "typecheck" script/.test(p)));
});

test("validateTypecheckScript flags a typecheck script pointed at the wrong tsconfig", () => {
  // Pointing typecheck at the default tsconfig (which excludes tests) would
  // silently stop covering test files while still looking green.
  const problems = validateTypecheckScript({ scripts: { typecheck: "tsc --noEmit" } });
  assert.ok(problems.some((p) => /tsconfig\.typecheck\.json/.test(p)));
});

test("validateCiWiring flags a workflow that does not run the gate", () => {
  assert.ok(validateCiWiring("jobs:\n  quality:\n    steps: []\n").length > 0);
});

test("validateCiWiring accepts a workflow that runs the gate", () => {
  assert.deepEqual(validateCiWiring("      - run: pnpm -C packages/web typecheck\n"), []);
});

// ── Drift guards against the REAL repo files ──────────────────────────────

test("packages/web/tsconfig.typecheck.json still covers test files", () => {
  const config = JSON.parse(readFileSync(join(WEB, "tsconfig.typecheck.json"), "utf8"));
  assert.deepEqual(
    validateTypecheckTsconfig(config),
    [],
    "tsconfig.typecheck.json no longer covers the web test files",
  );
});

test("packages/web/package.json wires the typecheck script to the gate config", () => {
  const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8"));
  assert.deepEqual(validateTypecheckScript(pkg), []);
});

test("CI runs the web typecheck gate", () => {
  const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.deepEqual(validateCiWiring(ci), []);
});

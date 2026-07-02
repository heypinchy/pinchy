import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import {
  discoverPluginDirs,
  validateTsconfigShape,
  validatePackageShape,
  validatePluginDir,
} from "./plugin-typecheck.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS_ROOT = join(REPO_ROOT, "packages", "plugins");

// A tsconfig shape that satisfies every rule the plugin typecheck gate needs:
// it typechecks production *and* test files, resolves node builtins, and
// tolerates third-party .d.ts breakage.
const GOOD = {
  compilerOptions: { strict: true, skipLibCheck: true, types: ["node", "vitest"] },
  include: ["**/*.ts"],
};

test("validateTsconfigShape accepts a config that covers production + test files", () => {
  assert.deepEqual(validateTsconfigShape(GOOD), []);
});

test("validateTsconfigShape flags a root-only include that misses __tests__/", () => {
  // The trap this guard exists for: `include: ["*.ts"]` only matches root-level
  // files, so __tests__/*.test.ts never gets typechecked — expectTypeOf
  // contract tests silently become no-ops.
  const problems = validateTsconfigShape({ ...GOOD, include: ["*.ts"] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\*\*\/\*\.ts/);
});

test("validateTsconfigShape flags an exclude that drops test files", () => {
  const problems = validateTsconfigShape({ ...GOOD, exclude: ["*.test.ts"] });
  assert.ok(
    problems.some((p) => /exclude/.test(p)),
    `expected an exclude problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateTsconfigShape flags __tests__ in exclude", () => {
  const problems = validateTsconfigShape({ ...GOOD, exclude: ["**/__tests__/**"] });
  assert.ok(problems.some((p) => /exclude/.test(p)));
});

test("validateTsconfigShape requires compilerOptions.types to include node", () => {
  const problems = validateTsconfigShape({ ...GOOD, compilerOptions: { skipLibCheck: true, types: ["vitest"] } });
  assert.ok(problems.some((p) => /node/.test(p)));
});

test("validateTsconfigShape requires skipLibCheck (third-party .d.ts otherwise breaks the gate)", () => {
  const problems = validateTsconfigShape({
    ...GOOD,
    compilerOptions: { types: ["node", "vitest"] },
  });
  assert.ok(problems.some((p) => /skipLibCheck/.test(p)));
});

test("validatePackageShape accepts an @types/node devDependency", () => {
  assert.deepEqual(
    validatePackageShape({ devDependencies: { "@types/node": "^26.1.0" } }),
    [],
  );
});

test("validatePackageShape requires @types/node so tsc can resolve node builtins", () => {
  // `types: ["node"]` in tsconfig throws TS2688 unless @types/node is actually
  // installed. The fast guard catches the missing dep before the slow tsc gate.
  const problems = validatePackageShape({ devDependencies: { vitest: "^4.1.9" } });
  assert.ok(problems.some((p) => /@types\/node/.test(p)));
});

test("validatePluginDir reports a missing tsconfig.json", () => {
  const problems = validatePluginDir(join(PLUGINS_ROOT, "pinchy-does-not-exist"));
  assert.deepEqual(problems, ["missing tsconfig.json"]);
});

// Drift guard: every real Pinchy plugin must be wired for the typecheck gate,
// so a new plugin cannot silently escape it (the read-side sibling of the
// no-untracked-skips guard — see AGENTS.md). If this fails, the plugin named
// in the message needs the uniform tsconfig (`include: ["**/*.ts"]`, no test
// exclude, skipLibCheck, types: ["node", "vitest"]) plus an @types/node devDep.
test("every packages/plugins/pinchy-* plugin is wired for the typecheck gate", () => {
  const dirs = discoverPluginDirs(PLUGINS_ROOT);
  assert.ok(dirs.length >= 8, `expected to discover the plugin packages, found ${dirs.length}`);
  const offenders = dirs
    .map((dir) => ({ name: basename(dir), problems: validatePluginDir(dir) }))
    .filter((r) => r.problems.length > 0);
  assert.deepEqual(
    offenders,
    [],
    `plugins not wired for typecheck:\n${offenders
      .map((o) => `  ${o.name}: ${o.problems.join("; ")}`)
      .join("\n")}`,
  );
});

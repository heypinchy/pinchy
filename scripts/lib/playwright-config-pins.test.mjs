import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename, relative } from "node:path";
import {
  configsReferencedByScripts,
  discoverPlaywrightConfigs,
  extractConfigEntries,
  validatePlaywrightConfigText,
} from "./playwright-config-pins.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_ROOT = join(REPO_ROOT, "packages", "web");

// A config text that satisfies every rule this guard enforces: retries: 0,
// workers: 1, and no fullyParallel: true.
const GOOD = `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/odoo",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
});
`;

test("validatePlaywrightConfigText accepts a config pinning retries: 0 and workers: 1", () => {
  assert.deepEqual(validatePlaywrightConfigText(GOOD), []);
});

test("validatePlaywrightConfigText flags retries: 2", () => {
  // A well-meaning "let's rerun flaky tests" edit is exactly the drift this
  // guard exists to catch: specs here truncate the DB / share an OpenClaw
  // session, so a retry can pass by re-running against state the first
  // attempt already mutated, silently hiding the flake instead of reporting it.
  const text = GOOD.replace("retries: 0", "retries: 2");
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /retries/.test(p)),
    `expected a retries problem, got ${JSON.stringify(problems)}`,
  );
});

test("validatePlaywrightConfigText flags fullyParallel: true", () => {
  // Specs in this suite call resetStack() (truncates the DB, restarts
  // containers) or share one OpenClaw session; two specs running in parallel
  // inside one stack would wipe each other's state.
  const text = GOOD.replace("fullyParallel: false", "fullyParallel: true");
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /fullyParallel/.test(p)),
    `expected a fullyParallel problem, got ${JSON.stringify(problems)}`,
  );
});

test("validatePlaywrightConfigText flags a missing workers: 1", () => {
  const text = GOOD.replace("  workers: 1,\n", "");
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /workers/.test(p)),
    `expected a workers problem, got ${JSON.stringify(problems)}`,
  );
});

test("validatePlaywrightConfigText flags a missing retries: 0", () => {
  const text = GOOD.replace("  retries: 0,\n", "");
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /retries/.test(p)),
    `expected a retries problem, got ${JSON.stringify(problems)}`,
  );
});

test("validatePlaywrightConfigText reports every problem in one pass, not just the first", () => {
  const text = GOOD.replace("retries: 0", "retries: 2").replace(
    "fullyParallel: false",
    "fullyParallel: true",
  );
  const problems = validatePlaywrightConfigText(text);
  assert.ok(problems.some((p) => /retries/.test(p)));
  assert.ok(problems.some((p) => /fullyParallel/.test(p)));
});

test('validatePlaywrightConfigText flags a non-numeric workers such as "50%"', () => {
  const text = GOOD.replace("workers: 1", 'workers: "50%"');
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /workers/.test(p)),
    `expected a workers problem, got ${JSON.stringify(problems)}`,
  );
});

// --- The comment blind spot -------------------------------------------------
//
// A first-match regex over the source reads a comment as configuration, which
// makes the guard report on the presence of a string rather than on the
// config. That is not a theoretical shape: the guard's own failure messages
// tell a developer to write `retries: 0`, so a comment carrying the literal
// pin next to (or instead of) the real one is the likeliest next commit.

test("a comment stating the pin does not excuse a violating value", () => {
  const text = `export default defineConfig({
  // retries: 0
  // workers: 1
  retries: 2,
  workers: 4,
});
`;
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /retries/.test(p)),
    `expected a retries problem, got ${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => /workers/.test(p)),
    `expected a workers problem, got ${JSON.stringify(problems)}`,
  );
});

test("a comment left behind after deleting the pin does not count as the pin", () => {
  const text = `export default defineConfig({
  // retries: 0
  // workers: 1
  reporter: "list",
});
`;
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /missing retries/.test(p)),
    `expected a missing-retries problem, got ${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => /missing workers/.test(p)),
    `expected a missing-workers problem, got ${JSON.stringify(problems)}`,
  );
});

test("a block comment describing the pins is not read as configuration", () => {
  const text = `/**
 * This suite pins retries: 0 and workers: 1 (AGENTS.md).
 */
export default defineConfig({
  fullyParallel: false,
  retries: 0,
  workers: 1,
});
`;
  assert.deepEqual(validatePlaywrightConfigText(text), []);
});

test("a // inside a string (baseURL) does not start a comment", () => {
  // playwright.config.ts really does carry `baseURL: "http://localhost:7778"`.
  // A comment stripper that is not string-aware would blank the rest of that
  // line — and, in a config where the URL precedes the pins, everything after.
  const text = `export default defineConfig({
  use: { baseURL: "http://localhost:7778" },
  fullyParallel: false,
  retries: 0,
  workers: 1,
});
`;
  assert.deepEqual(validatePlaywrightConfigText(text), []);
});

// --- Project-level overrides ------------------------------------------------

test("a project-level retries override is flagged even when the top level pins 0", () => {
  // Playwright honours `retries` per project, so this really does re-run
  // failing tests while the top-level pin sits there looking intact.
  const text = `export default defineConfig({
  fullyParallel: false,
  retries: 0,
  workers: 1,
  projects: [{ name: "chromium", retries: 3 }],
});
`;
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /retries is "3"/.test(p)),
    `expected a nested retries problem, got ${JSON.stringify(problems)}`,
  );
});

test("a project-level fullyParallel: true is flagged", () => {
  const text = `export default defineConfig({
  fullyParallel: false,
  retries: 0,
  workers: 1,
  projects: [{ name: "chromium", fullyParallel: true }],
});
`;
  const problems = validatePlaywrightConfigText(text);
  assert.ok(
    problems.some((p) => /fullyParallel/.test(p)),
    `expected a fullyParallel problem, got ${JSON.stringify(problems)}`,
  );
});

test("extractConfigEntries reports the nesting depth of each entry", () => {
  const entries = extractConfigEntries(`export default defineConfig({
  retries: 0,
  projects: [{ name: "chromium", retries: 3 }],
});
`);
  const retries = entries.filter((e) => e.key === "retries");
  assert.deepEqual(
    retries.map((e) => ({ value: e.value, depth: e.depth })),
    [
      { value: "0", depth: 1 },
      { value: "3", depth: 3 },
    ],
  );
});

// --- Canaries against the real config shape ---------------------------------
//
// The fixtures above are toys. AGENTS.md asks for verification by
// reproduction, so these mutate the real playwright.config.ts — comments, a
// testIgnore array, a webServer.command megastring, a baseURL containing `//`
// — and require the guard to catch drift in that shape, not just in a
// hand-written five-line object.

const REAL_CONFIG = readFileSync(
  join(WEB_ROOT, "playwright.config.ts"),
  "utf8",
);

test("canary: the real playwright.config.ts passes unmutated", () => {
  assert.deepEqual(validatePlaywrightConfigText(REAL_CONFIG), []);
});

test("canary: retries: 2 in the real config is caught", () => {
  const mutated = REAL_CONFIG.replace("retries: 0,", "retries: 2,");
  assert.notEqual(mutated, REAL_CONFIG, "mutation did not apply");
  const problems = validatePlaywrightConfigText(mutated);
  assert.ok(
    problems.some((p) => /retries is "2"/.test(p)),
    `expected a retries problem, got ${JSON.stringify(problems)}`,
  );
});

test("canary: deleting workers: 1 from the real config is caught", () => {
  const mutated = REAL_CONFIG.replace("  workers: 1,\n", "");
  assert.notEqual(mutated, REAL_CONFIG, "mutation did not apply");
  const problems = validatePlaywrightConfigText(mutated);
  assert.ok(
    problems.some((p) => /missing workers/.test(p)),
    `expected a missing-workers problem, got ${JSON.stringify(problems)}`,
  );
});

// --- Discovery --------------------------------------------------------------

test("discoverPlaywrightConfigs finds every packages/web/playwright*.config.ts", () => {
  const files = discoverPlaywrightConfigs(WEB_ROOT);
  assert.ok(
    files.every((f) => /playwright.*\.config\.ts$/.test(basename(f))),
    `expected only playwright*.config.ts files, got ${JSON.stringify(files.map((f) => basename(f)))}`,
  );
});

// Corpus floor (AGENTS.md): a guard that discovers nothing checks nothing. The
// repo has 9 Playwright configs today under packages/web; require at least 8
// so the guard fails loudly if the discovery walk breaks rather than passing
// vacuously.
test("discoverPlaywrightConfigs finds at least 8 configs (corpus floor)", () => {
  const files = discoverPlaywrightConfigs(WEB_ROOT);
  assert.ok(
    files.length >= 8,
    `expected to discover at least 8 playwright configs, found ${files.length}: ${JSON.stringify(
      files.map((f) => relative(WEB_ROOT, f)),
    )}`,
  );
});

test("discoverPlaywrightConfigs reaches configs in subdirectories", () => {
  // packages/web/eval/playwright.eval.config.ts is run by `pnpm eval:selftest`
  // in CI and sits one directory down. A package-root-only readdir — the
  // obvious implementation — leaves it entirely unguarded.
  const relatives = discoverPlaywrightConfigs(WEB_ROOT).map((f) =>
    relative(WEB_ROOT, f),
  );
  assert.ok(
    relatives.includes(join("eval", "playwright.eval.config.ts")),
    `expected the nested eval config to be discovered, got ${JSON.stringify(relatives)}`,
  );
});

// The floor only catches a walk that finds *nothing*. This catches the sharper
// case: a config the scripts really run that discovery does not reach — which
// is how the nested eval config went unguarded in the first place.
test("every config a packages/web script runs is discovered", () => {
  const referenced = configsReferencedByScripts(
    readFileSync(join(WEB_ROOT, "package.json"), "utf8"),
  );
  const discovered = new Set(
    discoverPlaywrightConfigs(WEB_ROOT).map((f) => relative(WEB_ROOT, f)),
  );
  const missing = referenced.filter((name) => !discovered.has(name));
  assert.ok(
    referenced.length >= 6,
    `expected the e2e scripts to reference configs, got ${JSON.stringify(referenced)}`,
  );
  assert.deepEqual(
    missing,
    [],
    `run by a packages/web script but never checked by this guard: ${JSON.stringify(missing)}`,
  );
});

test("configsReferencedByScripts reads --config and the implicit bare invocation", () => {
  const referenced = configsReferencedByScripts(
    JSON.stringify({
      scripts: {
        "test:e2e": "playwright test",
        "test:e2e:odoo": "playwright test --config playwright.odoo.config.ts",
        "test:e2e:web": "playwright test --config=./playwright.web.config.ts",
        lint: "eslint .",
      },
    }),
  );
  assert.deepEqual(referenced, [
    "playwright.config.ts",
    "playwright.odoo.config.ts",
    "playwright.web.config.ts",
  ]);
});

// Real-repo assertion: every actual packages/web/playwright*.config.ts must
// pin retries: 0, workers: 1, and must not set fullyParallel: true.
test("every real packages/web/playwright*.config.ts is pinned correctly", () => {
  const files = discoverPlaywrightConfigs(WEB_ROOT);
  const offenders = files
    .map((file) => ({
      file: file.replace(REPO_ROOT + "/", ""),
      problems: validatePlaywrightConfigText(readFileSync(file, "utf8")),
    }))
    .filter((r) => r.problems.length > 0);
  assert.deepEqual(
    offenders,
    [],
    `playwright configs not pinned:\n${offenders
      .map((o) => `  ${o.file}: ${o.problems.join("; ")}`)
      .join("\n")}`,
  );
});

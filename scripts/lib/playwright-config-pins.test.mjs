import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import {
  discoverPlaywrightConfigs,
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

test("discoverPlaywrightConfigs finds every packages/web/playwright*.config.ts", () => {
  const files = discoverPlaywrightConfigs(WEB_ROOT);
  assert.ok(
    files.every((f) => /playwright.*\.config\.ts$/.test(basename(f))),
    `expected only playwright*.config.ts files, got ${JSON.stringify(files.map((f) => basename(f)))}`,
  );
});

// Corpus floor (AGENTS.md): a guard that discovers nothing checks nothing. The
// repo has 8 Playwright configs today under packages/web; require at least 6
// so the guard fails loudly if the discovery glob breaks rather than passing
// vacuously.
test("discoverPlaywrightConfigs finds at least 6 configs (corpus floor)", () => {
  const files = discoverPlaywrightConfigs(WEB_ROOT);
  assert.ok(
    files.length >= 6,
    `expected to discover at least 6 playwright configs, found ${files.length}: ${JSON.stringify(
      files.map((f) => basename(f)),
    )}`,
  );
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

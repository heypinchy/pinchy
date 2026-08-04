import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  playwrightJobs,
  jobsMissingFailureDiagnostics,
  playwrightConfigPaths,
  configsMissingFailureArtifacts,
  REQUIRED_USE_KEYS,
} from "./e2e-diagnostics-coverage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const WEB_DIR = join(ROOT, "packages", "web");

function workflowFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-diagnostics-"));
  const path = join(dir, "ci.yml");
  writeFileSync(path, body);
  return path;
}

/** A job that runs Playwright, with whatever diagnostics steps are given. */
function playwrightJob(name, diagnosticsSteps) {
  return `  ${name}:
    name: ${name}
    runs-on: ubuntu-latest
    services:
      postgres:
        ports:
          - 5433:5432
    steps:
      - uses: actions/checkout@v7

      - uses: ./.github/actions/setup-playwright

      - name: Run E2E tests
        run: pnpm -C packages/web test:e2e
${diagnosticsSteps}`;
}

const COMPOSITE_STEP = `
      - name: Capture diagnostics on failure
        if: failure()
        uses: ./.github/actions/capture-e2e-diagnostics
        with:
          compose-files: "-f docker-compose.yml"
          artifact-name: "some-e2e"
`;

const DIRECT_UPLOAD_STEP = `
      - name: Upload Playwright diagnostics on failure
        if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: e2e-failure-\${{ github.run_id }}
          path: packages/web/test-results/
          if-no-files-found: warn
`;

// ---------------------------------------------------------------------------
// playwrightJobs
// ---------------------------------------------------------------------------

test("playwrightJobs finds jobs that set Playwright up, and only those", () => {
  const path = workflowFixture(
    `name: CI
jobs:
${playwrightJob("e2e", COMPOSITE_STEP)}
  quality:
    name: Lint, Test & Build
    steps:
      - run: pnpm test
`,
  );
  assert.deepEqual(
    playwrightJobs(path).map((j) => j.jobName),
    ["e2e"],
  );
});

// ---------------------------------------------------------------------------
// jobsMissingFailureDiagnostics — the silent half
// ---------------------------------------------------------------------------

test("the shared composite action satisfies the rule", () => {
  const path = workflowFixture(
    `name: CI\njobs:\n${playwrightJob("odoo-e2e", COMPOSITE_STEP)}`,
  );
  assert.deepEqual(jobsMissingFailureDiagnostics(path), []);
});

test("a direct upload of test-results satisfies the rule", () => {
  const path = workflowFixture(
    `name: CI\njobs:\n${playwrightJob("e2e", DIRECT_UPLOAD_STEP)}`,
  );
  assert.deepEqual(jobsMissingFailureDiagnostics(path), []);
});

test("if: always() is accepted — it still runs after a failure", () => {
  const path = workflowFixture(
    `name: CI\njobs:\n${playwrightJob("e2e", DIRECT_UPLOAD_STEP.replace("if: failure()", "if: always()"))}`,
  );
  assert.deepEqual(jobsMissingFailureDiagnostics(path), []);
});

test("a Playwright job with no diagnostics step at all is an offender", () => {
  const path = workflowFixture(`name: CI\njobs:\n${playwrightJob("e2e", "")}`);
  const offenders = jobsMissingFailureDiagnostics(path);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].jobName, "e2e");
  assert.match(offenders[0].reason, /uploads no diagnostics/);
});

test("an upload of something other than test-results does not count", () => {
  const path = workflowFixture(
    `name: CI\njobs:\n${playwrightJob("e2e", DIRECT_UPLOAD_STEP.replace("packages/web/test-results/", "coverage/"))}`,
  );
  assert.equal(jobsMissingFailureDiagnostics(path).length, 1);
});

test("an upload step with no `if:` is an offender — it never runs on failure", () => {
  const path = workflowFixture(
    `name: CI\njobs:\n${playwrightJob("e2e", DIRECT_UPLOAD_STEP.replace("        if: failure()\n", ""))}`,
  );
  const offenders = jobsMissingFailureDiagnostics(path);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /cannot run after a failure/);
});

test("a Playwright job whose steps cannot be read throws instead of passing", () => {
  const path = workflowFixture(
    `name: CI
jobs:
  e2e:
    name: E2E Tests
    steps: \${{ fromJSON(needs.gen.outputs.steps) }}
    # ./.github/actions/setup-playwright referenced indirectly
`,
  );
  assert.throws(
    () => jobsMissingFailureDiagnostics(path),
    /declares no steps this sweep can read/,
  );
});

// ---------------------------------------------------------------------------
// configsMissingFailureArtifacts — an upload is worth what the config wrote
// ---------------------------------------------------------------------------

function configFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "pw-configs-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

const COMPLETE_CONFIG = `import { defineConfig } from "@playwright/test";
export default defineConfig({
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
`;

test("a config declaring both keys is not an offender", () => {
  const dir = configFixture({ "playwright.config.ts": COMPLETE_CONFIG });
  assert.deepEqual(configsMissingFailureArtifacts(dir), []);
});

test("a config missing screenshot is an offender", () => {
  const dir = configFixture({
    "playwright.integration.config.ts": COMPLETE_CONFIG.replace(
      '    screenshot: "only-on-failure",\n',
      "",
    ),
  });
  const offenders = configsMissingFailureArtifacts(dir);
  assert.equal(offenders.length, 1);
  assert.deepEqual(offenders[0].missing, ["screenshot"]);
});

test('a key set to "off" counts as missing — it produces the same silence', () => {
  const dir = configFixture({
    "playwright.config.ts": COMPLETE_CONFIG.replace(
      'trace: "retain-on-failure"',
      'trace: "off"',
    ),
  });
  assert.deepEqual(configsMissingFailureArtifacts(dir)[0].missing, ["trace"]);
});

test("the walk finds nested configs and skips node_modules", () => {
  const dir = configFixture({
    "playwright.config.ts": COMPLETE_CONFIG,
    "eval/playwright.eval.config.ts": COMPLETE_CONFIG,
    "node_modules/pkg/playwright.config.ts": "export default {};\n",
  });
  assert.deepEqual(
    playwrightConfigPaths(dir).map((p) => p.slice(dir.length + 1)),
    ["eval/playwright.eval.config.ts", "playwright.config.ts"],
  );
});

// ---------------------------------------------------------------------------
// The real corpus. A sweep that finds nothing would pass every check above.
// ---------------------------------------------------------------------------

test("ci.yml's real Playwright jobs all upload diagnostics on failure", () => {
  const jobs = playwrightJobs(CI_WORKFLOW);
  assert.ok(
    jobs.length >= 9,
    `expected ci.yml to run Playwright in at least 9 jobs, found ${jobs.length} — ` +
      `the sweep is probably broken rather than the workflow`,
  );
  assert.deepEqual(
    jobsMissingFailureDiagnostics(CI_WORKFLOW),
    [],
    "every job running Playwright must leave something behind when it goes red",
  );
});

test("every real Playwright config asks Playwright to write diagnostics", () => {
  const configs = playwrightConfigPaths(WEB_DIR);
  assert.ok(
    configs.length >= 9,
    `expected at least 9 playwright configs under packages/web, found ${configs.length} — ` +
      `the walk is probably broken rather than the tree`,
  );
  assert.deepEqual(
    configsMissingFailureArtifacts(WEB_DIR).map(
      (o) => `${o.path}: missing ${o.missing.join(", ")}`,
    ),
    [],
    `every config must set ${REQUIRED_USE_KEYS.join(" and ")} — an upload is only worth what the config wrote`,
  );
});

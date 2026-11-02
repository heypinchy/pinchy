/**
 * The LibreOffice suites (`packages/web/src/**\/*.libreoffice.test.ts`) drive a
 * real `soffice`. They must run ONLY through their own runner, and that runner
 * must really run somewhere.
 *
 * Why their own runner: under the default vitest config they ran in parallel
 * workers on any machine that has `soffice` installed, two LibreOffice first
 * starts raced on one extension repository (signal 6 in 7.4.7), and the
 * canary's 240 s budget turned into 89 s / 180 s timeouts on a loaded laptop
 * (third review, PR #1243). On a machine without `soffice` they skipped —
 * which is every CI runner, so in CI they had never run at all.
 *
 * So: excluded from `vitest.config.ts`, run by `vitest.libreoffice.config.ts`
 * one file at a time (`pnpm test:libreoffice`), and run in CI inside the
 * Pinchy image the pipeline built — the LibreOffice that ships — with
 * `KB_REQUIRE_SOFFICE=1`, so a missing binary fails instead of skipping. Each
 * of those is a line someone could drop without any test going red; this file
 * is that test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GATE_EXPRESSION, UNGATED_JOBS } from "./ci-path-filter.mjs";
import { splitWorkflowTextIntoJobs } from "./workflow-jobs.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB = join(ROOT, "packages", "web");
const read = (...parts) => readFileSync(join(...parts), "utf8");

function libreofficeTestFiles(dir = join(WEB, "src")) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...libreofficeTestFiles(path));
    else if (entry.name.endsWith(".libreoffice.test.ts")) found.push(path);
  }
  return found;
}

test("there are LibreOffice suites to run (the sweep found a real corpus)", () => {
  assert.ok(
    libreofficeTestFiles().length >= 2,
    "expected at least the canary and its sibling",
  );
});

test("the default vitest config excludes them", () => {
  assert.match(
    read(WEB, "vitest.config.ts"),
    /"\*\*\/\*\.libreoffice\.test\.\{ts,tsx\}"/,
  );
});

test("their own config includes them and runs one file at a time", () => {
  const config = read(WEB, "vitest.libreoffice.config.ts");
  assert.match(config, /include:\s*\["src\/\*\*\/\*\.libreoffice\.test\.ts"\]/);
  assert.match(config, /fileParallelism:\s*false/);
});

test("pnpm test:libreoffice runs that config, from the root and from the web package", () => {
  const web = JSON.parse(read(WEB, "package.json")).scripts;
  const root = JSON.parse(read(ROOT, "package.json")).scripts;
  assert.equal(
    web["test:libreoffice"],
    "vitest run --config vitest.libreoffice.config.ts",
  );
  assert.equal(
    root["test:libreoffice"],
    "pnpm --filter @pinchy/web test:libreoffice",
  );
});

test("each suite fails, rather than skips, when KB_REQUIRE_SOFFICE=1 and soffice is missing", () => {
  for (const path of libreofficeTestFiles()) {
    assert.match(
      readFileSync(path, "utf8"),
      /process\.env\.KB_REQUIRE_SOFFICE === "1"/,
      `${path} must honour KB_REQUIRE_SOFFICE`,
    );
  }
});

test("ci.yml runs them inside the image the pipeline built, gated like every non-required job", () => {
  // Comments dropped: the splitter hands a job the comment block that
  // introduces the NEXT job, and a comment that mentions the script runs nothing.
  const jobs = splitWorkflowTextIntoJobs(
    read(ROOT, ".github", "workflows", "ci.yml"),
  ).map((job) => ({
    ...job,
    body: job.body
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n"),
  }));
  const runners = jobs.filter((job) => /test:libreoffice/.test(job.body));
  assert.equal(
    runners.length,
    1,
    "exactly one ci.yml job runs pnpm test:libreoffice",
  );
  const [job] = runners;

  // Not a required check: a new required check means changing branch
  // protection, which is not this file's call (AGENTS.md).
  assert.ok(
    !(job.jobName in UNGATED_JOBS),
    `${job.jobName} must not be ungated`,
  );
  assert.match(job.body, /needs:\s*\[changes, build-image\]/);
  assert.ok(job.body.includes(GATE_EXPRESSION), "gated on the changes job");
  assert.doesNotMatch(job.body, /strategy:|matrix:/, "no matrix");

  // The LibreOffice that ships: the pipeline's own image, or its local build on a fork PR.
  assert.match(job.body, /needs\.build-image\.outputs\.pinchy-image/);
  assert.match(job.body, /docker build -t \S+ -f Dockerfile\.pinchy \./);
  assert.match(job.body, /KB_REQUIRE_SOFFICE=1/);
  assert.match(job.body, /--network none/);
});

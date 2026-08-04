/**
 * Two invariants that decide whether a red Playwright job can be diagnosed at
 * all, and that neither GitHub Actions nor Playwright would ever complain
 * about.
 *
 * Both fail SILENTLY, which is why they are guards and not comments:
 *
 *  1. A Playwright job with no failure-time artifact step leaves a maintainer
 *     with nothing but the list reporter's terse text. Eight of ci.yml's nine
 *     Playwright jobs got `capture-e2e-diagnostics`; the base `e2e` job — the
 *     REQUIRED check, the one whose flakes actually block merges — was the one
 *     nobody came back to (#1061). Adding the ninth by hand fixes today and
 *     pins nothing: the tenth job drifts exactly the same way. That is the
 *     failure AGENTS.md § "A Hand-Maintained List That Mirrors Code Will Be
 *     Wrong" describes, and the reason the one list with a guard
 *     (`contracts.tools`) is the one list that stayed correct.
 *
 *  2. An upload is only ever worth what the config told Playwright to write.
 *     `playwright.integration.config.ts` set `trace` but not `screenshot`, so
 *     `capture-e2e-diagnostics` advertised a bundle containing "Playwright
 *     traces, screenshots, and full container logs" and shipped one with no
 *     screenshots for that suite. Uploading the right directory and filling it
 *     are two separate claims; CI can only ever observe the first.
 *
 * What this deliberately does NOT check: that the captured artifact is USEFUL.
 * `trace: "on-first-retry"` is a legitimate value that captures nothing here,
 * because every config in this repo pins `retries: 0` on purpose (a flake is a
 * signal, not something a rerun hides). Nothing below would notice. This is a
 * tripwire against the omissions that actually happened, not a proof that a
 * failed run is diagnosable.
 *
 * Textual sweeps, dependency-free, matching the other workflow guards here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitWorkflowIntoJobs } from "./workflow-jobs.mjs";

/** A job runs Playwright iff it sets Playwright up. */
const SETUP_PLAYWRIGHT = "./.github/actions/setup-playwright";

/** The shared composite action; the docker-compose-backed suites use it. */
const CAPTURE_ACTION = "./.github/actions/capture-e2e-diagnostics";

/**
 * Playwright's default `outputDir` is `<nearest package.json dir>/test-results`
 * (`path.join(packageJsonDir, 'test-results')` in playwright's common/config).
 * `packages/web/eval/` has no package.json of its own, so EVERY config in this
 * repo — including the nested eval one — writes to `packages/web/test-results`,
 * and every upload step names that one directory.
 */
const OUTPUT_DIR_TOKEN = "test-results";

/** `use:` keys without which a failed run leaves nothing behind to upload. */
export const REQUIRED_USE_KEYS = ["trace", "screenshot"];

/** Directories a config never hides in, and that a walk must not descend. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".next",
  "test-results",
  "playwright-report",
  "dist",
]);

/**
 * Splits a job body into its step blocks. Steps are the 6-space-indented list
 * items under `steps:`; a block runs from its `- ` line to the next one (or to
 * the end of the job).
 *
 * Deeper list items — a service's `ports:`, a multi-line `path: |` — are
 * indented past 6 and stay inside the step they belong to.
 *
 * @param {string} body
 * @returns {string[]}
 */
function splitJobIntoSteps(body) {
  const lines = body.split("\n");
  const steps = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {6}- /.test(lines[i])) continue;
    if (start !== -1) steps.push(lines.slice(start, i).join("\n"));
    start = i;
  }
  if (start !== -1) steps.push(lines.slice(start).join("\n"));
  return steps;
}

/**
 * Can this step still run once the job has failed? A step with no `if:` at all
 * runs only on success, so an upload-artifact added without one never fires on
 * the failures it exists for — green step, no artifact, nothing to notice.
 *
 * @param {string} step
 * @returns {boolean}
 */
function runsAfterFailure(step) {
  return /^\s+if:.*(failure\(\)|always\(\)|!\s*cancelled\(\))/m.test(step);
}

/**
 * Does this step upload a bundle carrying Playwright's own output?
 *
 * @param {string} step
 * @returns {boolean}
 */
function capturesPlaywrightOutput(step) {
  if (step.includes(CAPTURE_ACTION)) return true;
  return (
    step.includes("uses: actions/upload-artifact@") &&
    step.includes(OUTPUT_DIR_TOKEN)
  );
}

/**
 * Every ci.yml job that runs Playwright.
 *
 * @param {string} workflowPath absolute path to a workflow file
 * @returns {Array<{ jobName: string, body: string, path: string }>}
 */
export function playwrightJobs(workflowPath) {
  return splitWorkflowIntoJobs(workflowPath).filter((job) =>
    job.body.includes(SETUP_PLAYWRIGHT),
  );
}

/**
 * Every Playwright job that cannot produce diagnostics when it goes red.
 *
 * A job whose step list this sweep cannot read THROWS rather than reporting
 * "no offenders". Refusing to answer is the only honest response to input it
 * cannot check — returning a clean verdict would let the guard stop guarding
 * the moment somebody reindents a job, which is the silent-coverage-loss this
 * whole module exists to prevent.
 *
 * @param {string} workflowPath absolute path to a workflow file
 * @throws if a Playwright job declares no readable steps
 * @returns {Array<{ jobName: string, reason: string }>}
 */
export function jobsMissingFailureDiagnostics(workflowPath) {
  const offenders = [];

  for (const job of playwrightJobs(workflowPath)) {
    const steps = splitJobIntoSteps(job.body);
    if (steps.length === 0) {
      throw new Error(
        `${job.jobName} sets Playwright up but declares no steps this sweep can read. ` +
          `Either the job is broken, or its steps are written in a shape (different ` +
          `indentation, a YAML anchor) this textual sweep does not understand.`,
      );
    }

    const capturing = steps.filter(capturesPlaywrightOutput);
    if (capturing.length === 0) {
      offenders.push({
        jobName: job.jobName,
        reason:
          `runs Playwright but uploads no diagnostics. Add a ` +
          `\`uses: ${CAPTURE_ACTION}\` step (docker-compose stacks) or an ` +
          `\`actions/upload-artifact\` step for packages/web/${OUTPUT_DIR_TOKEN}/ ` +
          `(jobs running Playwright's own webServer), gated \`if: failure()\`.`,
      });
      continue;
    }

    if (!capturing.some(runsAfterFailure)) {
      offenders.push({
        jobName: job.jobName,
        reason:
          `uploads diagnostics from a step that cannot run after a failure. ` +
          `A step with no \`if:\` runs only on success, so the artifact never ` +
          `appears for the failures it exists for. Add \`if: failure()\`.`,
      });
    }
  }

  return offenders;
}

/**
 * Every `playwright*.config.ts` under the given directory.
 *
 * @param {string} webDir absolute path to packages/web
 * @returns {string[]} absolute paths, sorted
 */
export function playwrightConfigPaths(webDir) {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith("."))
          continue;
        walk(join(dir, entry.name));
      } else if (/^playwright[\w.-]*\.config\.ts$/.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(webDir);

  return found.sort();
}

/**
 * Every Playwright config that leaves a failed run with nothing to upload.
 *
 * `"off"` counts as missing: a key set to `"off"` produces exactly the silence
 * an absent key does, and reads as a decision rather than an omission.
 *
 * @param {string} webDir absolute path to packages/web
 * @returns {Array<{ path: string, missing: string[] }>}
 */
export function configsMissingFailureArtifacts(webDir) {
  const offenders = [];

  for (const path of playwrightConfigPaths(webDir)) {
    const source = readFileSync(path, "utf8");
    const missing = REQUIRED_USE_KEYS.filter(
      (key) => !new RegExp(`^\\s*${key}:\\s*"(?!off")`, "m").test(source),
    );
    if (missing.length > 0) offenders.push({ path, missing });
  }

  return offenders;
}

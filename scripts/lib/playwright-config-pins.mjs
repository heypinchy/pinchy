/**
 * Drift guard for the Playwright flake-signal pins.
 *
 * AGENTS.md § "No Untracked Sleeps In E2E" states the property in passing:
 * every Playwright config here pins `retries: 0, workers: 1` on purpose — a
 * flake is a signal, not something a rerun hides. Nothing pinned that claim
 * itself. A well-meaning `retries: 2` landing in one of the eight
 * `packages/web/playwright*.config.ts` files would quietly turn a real flake
 * into an intermittent pass, and CI would stay green while doing so.
 *
 * The property is not just "retries: 0, workers: 1 literally appear" — a
 * config could set `workers: 1` and still race two specs against one stack
 * via `fullyParallel: true` (Playwright's own default when neither is set is
 * `workers` scaled off CPU count and `fullyParallel: false`, but an explicit
 * `true` overrides `workers: 1` for tests *within* one file). Every config
 * here that states the field spells it out as `false`; this guard forbids
 * `true` for the same reason it forbids `retries` above 0: specs in this repo
 * call `resetStack()` (truncates the DB, restarts containers) or share one
 * OpenClaw session, so two specs running concurrently inside one stack wipe
 * each other's state.
 *
 * Text analysis, not `require()`/dynamic import: these are Playwright
 * `defineConfig()` modules meant to run under Playwright's own loader, and
 * importing them here would need every mock server and DB env var they
 * reference (see the `webServer.command` block in playwright.config.ts).
 * Reading the source text is what the analogous *-gate guards in this
 * directory already do (see node-version-pin.mjs's Dockerfile/workflow
 * readers). It is also a legitimate reading of AGENTS.md's own contract:
 * `AGENTS.md` states the property in prose, so a text-level check of the
 * config source is the natural read-side sibling — the same shape as
 * upgrading-released-sections.mjs reading a doc section as text.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

// Matches every `packages/web/playwright*.config.ts` file: the bare
// `playwright.config.ts` and every suffixed variant
// (`playwright.odoo.config.ts`, `playwright.email.config.ts`, ...).
const CONFIG_FILE_PATTERN = /^playwright.*\.config\.ts$/;

/**
 * Discover every Playwright config file directly under a web package root.
 * @param {string} webRoot absolute path to packages/web
 * @returns {string[]} sorted absolute file paths
 */
export function discoverPlaywrightConfigs(webRoot) {
  return readdirSync(webRoot)
    .filter((name) => CONFIG_FILE_PATTERN.test(name))
    .map((name) => join(webRoot, name))
    .sort();
}

/**
 * Find a top-level `key: value` assignment inside a `defineConfig({...})`
 * object literal. Deliberately shallow — it looks for the key anywhere at
 * the top indentation level Playwright configs use, not a real parser, which
 * is the same tradeoff the sibling text-based guards in this directory make.
 * @param {string} text
 * @param {string} key
 * @returns {string | null} the raw value text, or null if the key is absent
 */
function findTopLevelValue(text, key) {
  const pattern = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*([^,\\n}]+)`);
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Validate one Playwright config's *source text* against the flake-signal
 * pins: `retries: 0`, `workers: 1`, and no `fullyParallel: true`.
 * @param {string} text raw config file contents
 * @returns {string[]} one message per problem; empty means correctly pinned
 */
export function validatePlaywrightConfigText(text) {
  const problems = [];
  const source = String(text ?? "");

  const retries = findTopLevelValue(source, "retries");
  if (retries === null) {
    problems.push(
      "missing retries: 0 — without it Playwright's own default reruns a failing test, hiding the flake this pin exists to surface.",
    );
  } else if (retries !== "0") {
    problems.push(
      `retries is ${JSON.stringify(retries)}, expected 0 — a retry can pass by re-running against DB state (or an OpenClaw session) the first attempt already mutated, silently hiding the flake instead of reporting it.`,
    );
  }

  const workers = findTopLevelValue(source, "workers");
  if (workers === null) {
    problems.push(
      "missing workers: 1 — without it Playwright sizes the worker pool off CPU count, and specs here truncate the DB / restart containers, so two workers can wipe each other's state.",
    );
  } else if (workers !== "1") {
    problems.push(
      `workers is ${JSON.stringify(workers)}, expected 1 — specs here truncate the DB / restart containers or share one OpenClaw session, so more than one worker can wipe another spec's state.`,
    );
  }

  const fullyParallel = findTopLevelValue(source, "fullyParallel");
  if (fullyParallel === "true") {
    problems.push(
      "fullyParallel is true, expected false (or absent) — it races tests within one file against a stack that resetStack()/shared-session specs assume is exclusively theirs.",
    );
  }

  return problems;
}

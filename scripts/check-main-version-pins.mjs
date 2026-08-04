#!/usr/bin/env node
/**
 * `main`'s version pins vs. the latest GitHub release (weekly cron, not a PR
 * gate — see AGENTS.md § "Forward-looking claims need an issue" for why).
 *
 * `pnpm release` bumps README, `.env.example` and the marketplace templates
 * only on the branch it runs on. A release cut from `release/X.Y` never
 * touches `main`, so without an explicit forward-port those pins sit stale
 * on `main` for the rest of the cycle — exactly what happened through all of
 * v0.9.0 (#1079). The `cut-pinchy-release` skill's "After the release"
 * section now names the forward-port as an explicit step; this script is the
 * tripwire for when that step gets skipped.
 *
 * Needs the network (the latest release) and `gh` on PATH, authenticated. A
 * network/API failure is reported as a warning and exits 0 — unknown is not
 * stale, and a laptop with no network should stay quiet rather than fail.
 *
 * Usage: node scripts/check-main-version-pins.mjs [--repo owner/name]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  collectMainVersionPins,
  findStaleVersionPins,
} from "./lib/main-version-pins.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const repoArgIndex = process.argv.indexOf("--repo");
const repo =
  (repoArgIndex !== -1 ? process.argv[repoArgIndex + 1] : undefined) ??
  process.env.GITHUB_REPOSITORY ??
  "heypinchy/pinchy";

function readRepoFile(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

let latestVersion;
try {
  latestVersion = execFileSync(
    "gh",
    ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"],
    { encoding: "utf8" },
  ).trim();
  if (!latestVersion) {
    throw new Error("empty tag_name in response");
  }
} catch (err) {
  process.stdout.write(
    `⚠ main-version-pins: could not resolve the latest release for ${repo} ` +
      `(${err.message ?? err}) — skipping this run. Unknown is not stale.\n`,
  );
  process.exit(0);
}

const pins = collectMainVersionPins({
  readme: readRepoFile("README.md"),
  envExample: readRepoFile(".env.example"),
  digitalOcean: readRepoFile("marketplace/digitalocean/template.json"),
  caprover: readRepoFile("marketplace/caprover/pinchy.yml"),
});

const stale = findStaleVersionPins(pins, latestVersion);

if (stale.length === 0) {
  process.stdout.write(
    `✓ main-version-pins: all pins track ${latestVersion} within a minor.\n`,
  );
  process.exit(0);
}

const lines = [
  `## main's version pins are a full minor behind ${latestVersion} (${stale.length})`,
  "",
  "`pnpm release` only bumps these on the branch it runs on. Forward-port the",
  "version-bump hunks from the last `chore: release` commit onto `main` — see",
  'the `cut-pinchy-release` skill\'s "After the release" section.',
  "",
  ...stale.map(
    (s) => `- ${s.label}: pinned at ${s.pinned}, latest is ${s.latest}`,
  ),
];
const text = lines.join("\n");
process.stdout.write(`${text}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
process.exit(1);

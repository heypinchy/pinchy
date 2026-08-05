#!/usr/bin/env node
/**
 * `main`'s version pins vs. the latest GitHub release (weekly cron, not a PR
 * gate — see AGENTS.md § "Forward-looking claims need an issue" for why).
 *
 * `pnpm release` bumps README, `.env.example`, both package.json versions and
 * the marketplace templates only on the branch it runs on. A release cut from
 * `release/X.Y` never
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

// A pin that cannot be READ is a different failure from a pin that is stale:
// it means an extractor stopped matching the file (a reformatted template, a
// renamed README heading), and reporting it as drift would send someone
// forward-porting a version that is already correct. Fail loudly either way —
// but say which one it is, rather than surfacing a bare stack trace on a
// weekly cron.
let pins;
try {
  pins = collectMainVersionPins({
    readme: readRepoFile("README.md"),
    envExample: readRepoFile(".env.example"),
    rootPackageJson: readRepoFile("package.json"),
    webPackageJson: readRepoFile("packages/web/package.json"),
    digitalOcean: readRepoFile("marketplace/digitalocean/template.json"),
    caprover: readRepoFile("marketplace/caprover/pinchy.yml"),
  });
} catch (err) {
  process.stdout.write(
    `✖ main-version-pins: could not read a version pin (${err.message ?? err}).\n` +
      `This is an extractor that stopped matching its file, NOT evidence that\n` +
      `main is stale — fix scripts/lib/main-version-pins.mjs (or the file it\n` +
      `reads) rather than forward-porting a version.\n`,
  );
  process.exit(1);
}

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

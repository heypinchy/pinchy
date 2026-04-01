#!/usr/bin/env node
/**
 * Pinchy release script
 *
 * Usage: pnpm release <version>
 *   e.g. pnpm release 0.3.0
 *
 * What it does:
 *   1. Validates the version (semver)
 *   2. Checks: clean working tree, on main branch, CI green
 *   3. Bumps version in root package.json and packages/web/package.json
 *   4. Commits, tags, and pushes
 *
 * What to do manually first (see CONTRIBUTING.md):
 *   - Update docs/src/content/docs/guides/upgrading.mdx
 *   - Update packages/web/src/lib/smithers-soul.ts if user-facing features changed
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAndValidateVersion,
  bumpPackageJson,
  buildTagName,
  buildCommitMessage,
} from "./lib/release-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function exec(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`\n✖ ${msg}\n\n`);
  process.exit(1);
}

// ─── Argument ────────────────────────────────────────────────────────────────

const input = process.argv[2];
if (!input) {
  fail("Usage: pnpm release <version>  (e.g. pnpm release 0.3.0)");
}

let version;
try {
  version = parseAndValidateVersion(input);
} catch (e) {
  fail(e.message);
}

const tag = buildTagName(version);
log(`\nReleasing Pinchy ${tag}\n`);

// ─── Pre-flight checks ────────────────────────────────────────────────────────

log("Checking working tree...");
const status = exec("git status --porcelain");
if (status) {
  fail(
    `Working tree is not clean. Commit or stash your changes first:\n${status}`,
  );
}
log("  ✔ Working tree clean");

log("Checking branch...");
const branch = exec("git branch --show-current");
if (branch !== "main") {
  fail(`Must release from main branch (currently on: ${branch})`);
}
log("  ✔ On main branch");

log("Checking CI status on main...");
const ciRun = exec(
  'gh run list --branch main --workflow CI --limit 1 --json conclusion,headBranch --jq ".[0]"',
);
const ci = JSON.parse(ciRun);
if (ci.conclusion !== "success") {
  fail(
    `CI is not green on main (conclusion: ${ci.conclusion}). Fix CI before releasing.`,
  );
}
log("  ✔ CI green");

log("Checking tag does not already exist...");
const existingTags = exec("git tag --list");
if (existingTags.split("\n").includes(tag)) {
  fail(`Tag ${tag} already exists.`);
}
log(`  ✔ Tag ${tag} is free`);

// ─── Version bumps ────────────────────────────────────────────────────────────

log("\nBumping versions...");

const rootPkgPath = resolve(ROOT, "package.json");
const webPkgPath = resolve(ROOT, "packages/web/package.json");

writeFileSync(rootPkgPath, bumpPackageJson(readFileSync(rootPkgPath, "utf8"), version));
log(`  ✔ package.json → ${version}`);

writeFileSync(webPkgPath, bumpPackageJson(readFileSync(webPkgPath, "utf8"), version));
log(`  ✔ packages/web/package.json → ${version}`);

// ─── Commit, tag, push ────────────────────────────────────────────────────────

log("\nCommitting...");
exec("git add package.json packages/web/package.json");
exec(`git commit -m "${buildCommitMessage(version)}"`);
log(`  ✔ Committed`);

log("Creating tag...");
exec(`git tag ${tag}`);
log(`  ✔ Tagged ${tag}`);

log("Pushing...");
exec("git push origin main");
exec(`git push origin ${tag}`);
log(`  ✔ Pushed\n`);

log(`✔ Released ${tag} — GitHub Actions will create the release and deploy docs.\n`);
log(`  https://github.com/heypinchy/pinchy/releases/tag/${tag}\n`);

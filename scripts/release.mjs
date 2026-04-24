#!/usr/bin/env node
/**
 * Pinchy release script
 *
 * Usage: pnpm release <version> [--skip-audit]
 *   e.g. pnpm release 0.5.0
 *        pnpm release 0.5.0 --skip-audit   # only after documenting the CVE acceptance
 *
 * What it does:
 *   1. Validates the version (semver)
 *   2. Gates:
 *      - upgrading.mdx has a section for the target version
 *      - clean working tree, on main branch, CI green, tag not taken
 *      - pnpm audit --audit-level=high --prod passes (or --skip-audit)
 *   3. Bumps version in root package.json and packages/web/package.json
 *   4. Commits, tags, and pushes
 *
 * What to do manually first (see CONTRIBUTING.md):
 *   - Update docs/src/content/docs/guides/upgrading.mdx (enforced)
 *   - Update packages/web/src/lib/smithers-soul.ts if user-facing features changed
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAndValidateVersion,
  bumpPackageJson,
  bumpEnvExample,
  buildTagName,
  buildCommitMessage,
  assertUpgradingSectionExists,
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
const skipAudit = process.argv.includes("--skip-audit");
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

// ─── Upgrade notes gate ───────────────────────────────────────────────────────

log("Checking upgrading.mdx has section for target version...");
let prevVersion;
try {
  prevVersion = exec("git describe --tags --abbrev=0").replace(/^v/, "");
} catch {
  fail(
    "No previous git tag found — cannot determine the 'from' version for upgrade notes.\n" +
      "If this is the first release, create the initial tag manually before running this script.",
  );
}
const upgradingMdxPath = resolve(
  ROOT,
  "docs/src/content/docs/guides/upgrading.mdx",
);
const upgradingMdx = readFileSync(upgradingMdxPath, "utf8");
try {
  assertUpgradingSectionExists(upgradingMdx, prevVersion, version);
} catch (e) {
  fail(e.message);
}
log(`  ✔ Section for v${version} present (from v${prevVersion})`);

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

// ─── Dependency audit gate ────────────────────────────────────────────────────

log("Running pnpm audit (production dependencies, high/critical only)...");
try {
  execSync("pnpm audit --audit-level=high --prod", {
    cwd: ROOT,
    stdio: "inherit",
  });
  log("  ✔ No high or critical vulnerabilities in production deps");
} catch {
  if (skipAudit) {
    log(
      "  ⚠ pnpm audit reported findings — continuing because --skip-audit was passed.",
    );
    log(
      "    Document the acceptance in the release notes (CONTRIBUTING.md).",
    );
  } else {
    fail(
      "pnpm audit reported high or critical vulnerabilities (or failed to connect to the registry — check output above).\n" +
        "Fix them, or re-run with --skip-audit and document the acceptance in the release notes.",
    );
  }
}

// ─── Version bumps ────────────────────────────────────────────────────────────

log("\nBumping versions...");

const rootPkgPath = resolve(ROOT, "package.json");
const webPkgPath = resolve(ROOT, "packages/web/package.json");
const envExamplePath = resolve(ROOT, ".env.example");

writeFileSync(rootPkgPath, bumpPackageJson(readFileSync(rootPkgPath, "utf8"), version));
log(`  ✔ package.json → ${version}`);

writeFileSync(webPkgPath, bumpPackageJson(readFileSync(webPkgPath, "utf8"), version));
log(`  ✔ packages/web/package.json → ${version}`);

writeFileSync(
  envExamplePath,
  bumpEnvExample(readFileSync(envExamplePath, "utf8"), version),
);
log(`  ✔ .env.example → v${version}`);

// ─── Commit, tag, push ────────────────────────────────────────────────────────

log("\nCommitting...");
exec("git add package.json packages/web/package.json .env.example");
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

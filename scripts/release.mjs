#!/usr/bin/env node
/**
 * Pinchy release script
 *
 * Usage: pnpm release <version> --verified=<sha> [--skip-audit]
 *   e.g. pnpm release 0.5.0 --verified=$(git rev-parse HEAD)
 *        pnpm release 0.5.0 --verified=… --skip-audit   # only after documenting the CVE acceptance
 *
 * `--verified` is the staging attestation: the SHA you verified on staging, and
 * it must equal HEAD. Run `pnpm release:preflight <version>` first — it prints
 * the manual gates to clear and then the exact command to run.
 *
 * What it does:
 *   1. Validates the version (semver)
 *   2. Gates:
 *      - upgrading.mdx has a section for the target version
 *      - clean working tree, on main or a release/* branch, tag not taken
 *      - CI green *for HEAD's own run* — not merely green somewhere on the branch
 *      - the --verified staging attestation matches HEAD
 *      - pnpm audit --audit-level=high --prod passes (or --skip-audit)
 *   3. Bumps version in root package.json, packages/web/package.json, and .env.example
 *   4. Commits, tags, opens the next cycle's upgrade-notes section in a
 *      follow-up commit, and pushes both
 *
 * What to do manually first (see CONTRIBUTING.md):
 *   - Update docs/src/content/docs/guides/upgrading.mdx (enforced)
 *   - Check docs/ covers this release's user-facing features — Smithers reads them on
 *     demand via the pinchy-docs plugin (docs_list / docs_read) and treats anything
 *     not in the docs as non-existent. Do NOT hardcode feature descriptions into
 *     smithers-soul.ts; it is deliberately docs-driven.
 */

import { execSync, execFileSync } from "node:child_process";
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
  assertUpgradeNotesWritten,
  finalizeUpgradeSection,
  openNextUpgradeSection,
  bumpReadmeQuickstartPins,
  isReleasableBranch,
  checkCiGreenForHead,
  checkReleaseVerification,
  parseVerifiedSha,
} from "./lib/release-logic.mjs";
import {
  bumpMarketplaceVersion,
  bumpCaproverVersion,
} from "./lib/marketplace-version.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function exec(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
}

// Like `exec`, but passes arguments as an argv array so a value (e.g. the
// current branch name) is never re-parsed by a shell — git refnames can legally
// contain shell metacharacters.
function execFile(file, args, opts = {}) {
  return execFileSync(file, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...opts,
  }).trim();
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
const verifiedSha = parseVerifiedSha(process.argv);
if (!input) {
  fail(
    "Usage: pnpm release <version> --verified=<sha>  (e.g. pnpm release 0.3.0 --verified=$(git rev-parse HEAD))",
  );
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
  // …and it must say something. The previous release opened this section from a
  // template that already satisfies the check above, so "does it exist" stopped
  // being the same question as "did anyone write it".
  assertUpgradeNotesWritten(upgradingMdx, prevVersion, version);
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
if (!isReleasableBranch(branch)) {
  fail(
    `Must release from main or a release/X.Y branch (currently on: ${branch || "detached HEAD"})`,
  );
}
log(`  ✔ On ${branch} branch`);

// CI's verdict has to be about the commit being tagged. Asking only for the
// newest run's conclusion answered "green" for a run that never saw this code
// — including on a clean tree whose HEAD was never pushed (#1085). So fetch a
// window of runs with their headSha and find HEAD's own.
log(`Checking CI status for HEAD on ${branch}...`);
const headSha = exec("git rev-parse HEAD");
let ciRuns = null;
try {
  ciRuns = JSON.parse(
    execFile("gh", [
      "run",
      "list",
      "--branch",
      branch,
      "--workflow",
      "CI",
      "--limit",
      "30",
      "--json",
      "conclusion,status,headSha,url",
    ]),
  );
} catch (e) {
  fail(`Could not read CI runs from gh: ${e.message}`);
}
const ciCheck = checkCiGreenForHead({ runs: ciRuns, headSha, branch });
if (!ciCheck.ok) {
  fail(ciCheck.message);
}
log(`  ✔ ${ciCheck.message}`);

// ─── Staging attestation ──────────────────────────────────────────────────────
//
// The manual staging gates are the ones that actually catch what CI cannot, and
// they were held only by prose in the cut-release skill — which is how v0.6.0
// shipped with the click-through never done. The preflight already printed
// `--verified=$(git rev-parse HEAD)`, but this script parsed only argv[2] and
// --skip-audit, so the flag was accepted and discarded: an operator who
// attested got exactly the same result as one who did not (#1085).
//
// Like the docs-review hook, this is not a fraud boundary — anyone can type the
// SHA without opening staging. It makes *forgetting* impossible, which is the
// failure mode that actually happens, and it ties the attestation to the exact
// commit rather than to the act of releasing.
log("Checking staging attestation...");
const attestation = checkReleaseVerification({ verifiedSha, headSha });
if (!attestation.ok) {
  fail(
    `${attestation.message}\n` +
      `Run \`pnpm release:preflight ${version}\` and verify each [ ] on staging first, then:\n` +
      `  pnpm release ${version} --verified=$(git rev-parse HEAD)`,
  );
}
log(`  ✔ ${attestation.message}`);

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
    log("    Document the acceptance in the release notes (CONTRIBUTING.md).");
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
const readmePath = resolve(ROOT, "README.md");

writeFileSync(
  rootPkgPath,
  bumpPackageJson(readFileSync(rootPkgPath, "utf8"), version),
);
log(`  ✔ package.json → ${version}`);

writeFileSync(
  webPkgPath,
  bumpPackageJson(readFileSync(webPkgPath, "utf8"), version),
);
log(`  ✔ packages/web/package.json → ${version}`);

writeFileSync(
  envExamplePath,
  bumpEnvExample(readFileSync(envExamplePath, "utf8"), version),
);
log(`  ✔ .env.example → v${version}`);

// Keep BOTH README quick-start pins on the released tag — the curl'd
// docker-compose.yml URL and the PINCHY_VERSION= line that compose file
// resolves its image tags from. They only work as a pair: bumping the URL
// alone starts cleanly and silently runs the previous release's images.
// (The curl pin sat on v0.5.7 through the v0.5.8 and v0.6.0 releases before
// this step existed.)
writeFileSync(
  readmePath,
  bumpReadmeQuickstartPins(readFileSync(readmePath, "utf8"), version),
);
log(`  ✔ README.md quick-start pins → v${version}`);

// Keep the marketplace listing templates pinned to the released version, so a
// fresh DigitalOcean install starts on the current release rather than drifting
// behind. The marketplace-version drift guard fails CI if this is ever skipped.
const doTemplatePath = resolve(ROOT, "marketplace/digitalocean/template.json");
writeFileSync(
  doTemplatePath,
  bumpMarketplaceVersion(readFileSync(doTemplatePath, "utf8"), version),
);
log(`  ✔ marketplace/digitalocean/template.json → v${version}`);

const caproverTemplatePath = resolve(ROOT, "marketplace/caprover/pinchy.yml");
writeFileSync(
  caproverTemplatePath,
  bumpCaproverVersion(readFileSync(caproverTemplatePath, "utf8"), version),
);
log(`  ✔ marketplace/caprover/pinchy.yml → v${version}`);

// Freeze the in-progress upgrade-notes section so the just-released version's
// `%%PINCHY_VERSION%%` placeholders become concrete. Without this, the section
// keeps the placeholder and the next release's docs build mis-renders these
// notes as that version's (the v0.5.8 miss). No-op if the author already wrote
// a concrete `to v${version}` heading.
const finalizedMdx = finalizeUpgradeSection(upgradingMdx, prevVersion, version);
if (finalizedMdx !== upgradingMdx) {
  writeFileSync(upgradingMdxPath, finalizedMdx);
  log(
    `  ✔ upgrading.mdx → froze v${prevVersion}→%%PINCHY_VERSION%% section to v${version}`,
  );
} else {
  log(`  ✔ upgrading.mdx → section already concrete (nothing to freeze)`);
}

// ─── Commit, tag, push ────────────────────────────────────────────────────────

log("\nCommitting...");
exec(
  `git add package.json packages/web/package.json .env.example README.md marketplace/digitalocean/template.json marketplace/caprover/pinchy.yml "${upgradingMdxPath}"`,
);
exec(`git commit -m "${buildCommitMessage(version)}"`);
log(`  ✔ Committed`);

log("Creating tag...");
exec(`git tag ${tag}`);
log(`  ✔ Tagged ${tag}`);

// Open the NEXT cycle's section — AFTER the tag, deliberately.
//
// Freezing closed a section and nothing opened the next one, so the first
// upgrade note after a release landed at the end of the file: inside the frozen
// section of the release that already shipped. Seven released sections on main
// had drifted that way. Opening it here removes the cause; the
// upgrading-released-sections guard is the tripwire for what slips past.
//
// It is a SEPARATE commit, created after `git tag`, because the tagged tree is
// what the docs deploy builds and inject-version.sh resolves every
// `%%PINCHY_VERSION%%` to the build version — so a skeleton inside the release
// commit would publish an empty "Upgrading from v<target> to v<target>" section
// at the top of the live upgrade guide. The branch gets the open section; the
// tag does not.
const frozenMdx = readFileSync(upgradingMdxPath, "utf8");
const openedMdx = openNextUpgradeSection(frozenMdx, prevVersion, version);
if (openedMdx !== frozenMdx) {
  writeFileSync(upgradingMdxPath, openedMdx);
  exec(`git add "${upgradingMdxPath}"`);
  exec(
    `git commit -m "docs(upgrading): open the v${version} → next upgrade section"`,
  );
  log(`  ✔ upgrading.mdx → opened v${version}→%%PINCHY_VERSION%% section`);
} else {
  log(`  ✔ upgrading.mdx → next section already open (nothing to add)`);
}

log("Pushing...");
exec("git push origin HEAD");
exec(`git push origin ${tag}`);
log(`  ✔ Pushed\n`);

log(
  `✔ Released ${tag} — GitHub Actions will create the release and deploy docs.\n`,
);
log(`  https://github.com/heypinchy/pinchy/releases/tag/${tag}\n`);

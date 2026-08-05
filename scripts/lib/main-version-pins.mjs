/**
 * Compares `main`'s version pins (README quick-start, `.env.example`, both
 * package.json versions, the two marketplace templates — every file
 * `scripts/release.mjs` bumps) against the latest published GitHub release,
 * and flags the ones that have drifted a full minor behind.
 *
 * `pnpm release` bumps these pins only on the branch it runs on — a release
 * cut from `release/X.Y` never touches `main`. Left unattended, that drift
 * survives an entire cycle: `.env.example` and both marketplace templates sat
 * at v0.8.0 through the whole v0.9.0 cycle, and PR #1053 could only hand-fix
 * the README pin because `marketplace-version.mjs` guards the templates
 * against `.env.example`'s PINCHY_VERSION — itself stale on `main` (#1079).
 *
 * This is deliberately NOT a PR gate: the question needs the network (the
 * latest release), the answer changes without anyone touching the repo, and
 * a check that can go red between two identical commits does not belong in
 * front of a merge button (see AGENTS.md § "Forward-looking claims need an
 * issue"). `scripts/check-main-version-pins.mjs` runs it from the weekly
 * `docs-freshness.yml` cron instead.
 *
 * A single patch/minor lag is not flagged — that is the normal state between
 * two release-branch cuts, since `main` legitimately only re-bumps at its
 * own next cut (or an explicit forward-port). A FULL minor behind is the
 * signal that the forward-port step described in the `cut-pinchy-release`
 * skill's "After the release" section was skipped for an entire cycle.
 *
 * Pure functions only — all I/O (reading the repo files, calling the GitHub
 * API) happens in the caller. Mirrors the shape of marketplace-version.mjs /
 * docs-consistency.mjs.
 */

import {
  extractQuickstartBlock,
  ENV_VERSION_PIN,
} from "./readme-quickstart-gate.mjs";
import {
  readPinchyVersionFromEnv,
  readMarketplaceVersion,
  readCaproverVersion,
} from "./marketplace-version.mjs";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parses a semver-ish string (with or without a leading "v") into numeric
 * parts.
 * @param {string} version
 * @returns {{major: number, minor: number, patch: number}}
 * @throws {Error} if the string isn't `[v]X.Y.Z`
 */
export function parseSemver(version) {
  const match = SEMVER.exec(String(version).trim());
  if (!match) {
    throw new Error(`"${version}" is not a vX.Y.Z (or X.Y.Z) version string`);
  }
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/**
 * Whether `latest` is a FULL minor (or major) release ahead of `pinned`. A
 * patch-only or same-minor difference does not count — that's the ordinary
 * gap between forward-ports, not the drift this guard exists to catch.
 * @param {string} pinned
 * @param {string} latest
 * @returns {boolean}
 */
export function isFullMinorBehind(pinned, latest) {
  const p = parseSemver(pinned);
  const l = parseSemver(latest);
  if (l.major !== p.major) return l.major > p.major;
  return l.minor > p.minor;
}

/**
 * Extracts the README quick-start's `PINCHY_VERSION=` pin.
 * @param {string} readme - raw README.md contents
 * @returns {string} e.g. "v0.9.1"
 * @throws {Error} if the quick-start block or its pin is missing
 */
export function readReadmeVersionPin(readme) {
  const block = extractQuickstartBlock(readme);
  const match = ENV_VERSION_PIN.exec(block);
  if (!match) {
    throw new Error(
      "README Quick Start block has no PINCHY_VERSION=vX.Y.Z pin to read",
    );
  }
  return match[1];
}

/**
 * Reads a package.json's `version` field. Unlike every other pin here this one
 * carries no leading "v" — `parseSemver` accepts both, and the value is
 * reported verbatim rather than normalised so the message names what the file
 * actually says.
 * @param {string} content - raw package.json contents
 * @returns {string} e.g. "0.9.1"
 * @throws {Error} if the file has no version field
 */
export function readPackageJsonVersion(content) {
  const version = JSON.parse(content)?.version;
  if (!version) {
    throw new Error("package.json has no version field to read");
  }
  return version;
}

/**
 * Reads every tracked pin out of the raw file contents supplied by the
 * caller.
 * One entry per file `scripts/release.mjs` bumps — all six, not the four that
 * happen to carry a `vX.Y.Z` string. Both package.json versions drift exactly
 * like the rest (main sat at 0.8.0 through the whole v0.9.0 cycle) and the
 * forward-port step in the `cut-pinchy-release` skill names them explicitly,
 * so a tripwire that skipped them would under-report the very incident it was
 * built for. `package.json#version` also has a second reader: staging tracks
 * `:next` off main, so a stale one makes `/api/version` — the thing the
 * release checklist tells you to verify — report the wrong release.
 *
 * @param {object} files
 * @param {string} files.readme - README.md contents
 * @param {string} files.envExample - .env.example contents
 * @param {string} files.rootPackageJson - package.json contents
 * @param {string} files.webPackageJson - packages/web/package.json contents
 * @param {string} files.digitalOcean - marketplace/digitalocean/template.json contents
 * @param {string} files.caprover - marketplace/caprover/pinchy.yml contents
 * @returns {Record<string, string>} label -> pinned version
 */
export function collectMainVersionPins({
  readme,
  envExample,
  rootPackageJson,
  webPackageJson,
  digitalOcean,
  caprover,
}) {
  return {
    "README quick-start": readReadmeVersionPin(readme),
    ".env.example": readPinchyVersionFromEnv(envExample),
    "package.json": readPackageJsonVersion(rootPackageJson),
    "packages/web/package.json": readPackageJsonVersion(webPackageJson),
    "DigitalOcean marketplace template": readMarketplaceVersion(digitalOcean),
    "CapRover marketplace template": readCaproverVersion(caprover),
  };
}

/**
 * The two pins that answer "what is this tree?" rather than "what should I
 * pull?". Since #1044 they carry `<next>-dev` at every moment that is not a
 * release commit, so being AHEAD of the latest release is their correct state,
 * not drift. The other four are install instructions and must name a tag that
 * exists — a `-dev` version there is a pull command nobody can run.
 *
 * @type {ReadonlySet<string>}
 */
export const DECLARED_VERSION_PINS = new Set([
  "package.json",
  "packages/web/package.json",
]);

/**
 * @param {Record<string, string>} pins - label -> pinned version
 * @param {string} latestVersion - the latest published release tag
 * @returns {Array<{label: string, pinned: string, latest: string}>}
 */
export function findStaleVersionPins(pins, latestVersion) {
  return Object.entries(pins)
    .filter(([label, pinned]) => {
      // A `-dev` declared version is the intended state between releases; it is
      // ahead of the latest release by construction. Whether it is far enough
      // ahead is `version-identity.mjs`'s question, and that one is a PR gate,
      // so this cron does not need to re-answer it — it would only get a second,
      // weekly chance to say the same thing.
      //
      // A declared pin WITHOUT the suffix still goes through the normal check.
      // That is the incident this guard was built for: `main` sat at a bare
      // `0.8.0` through the whole v0.9.0 cycle, and a bare version claims to BE
      // a release, so it has to be a current one.
      if (DECLARED_VERSION_PINS.has(label) && /-dev$/.test(pinned))
        return false;
      return isFullMinorBehind(pinned, latestVersion);
    })
    .map(([label, pinned]) => ({ label, pinned, latest: latestVersion }));
}

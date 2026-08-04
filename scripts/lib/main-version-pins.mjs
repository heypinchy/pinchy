/**
 * Compares `main`'s version pins (README quick-start, `.env.example`, the two
 * marketplace templates) against the latest published GitHub release, and
 * flags the ones that have drifted a full minor behind.
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

import { extractQuickstartBlock } from "./readme-quickstart-gate.mjs";
import {
  readPinchyVersionFromEnv,
  readMarketplaceVersion,
  readCaproverVersion,
} from "./marketplace-version.mjs";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * The README quick-start's `PINCHY_VERSION=vX.Y.Z` pin. Mirrors
 * `ENV_VERSION_PIN` in readme-quickstart-gate.mjs — kept separate rather than
 * exported from there because the two guards check different things (that
 * guard checks internal agreement within the README; this one checks
 * staleness against a live release) and this file already imports that
 * module's block extractor.
 */
const README_ENV_VERSION_PIN = /PINCHY_VERSION=(v\d+\.\d+\.\d+)/;

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
  const match = README_ENV_VERSION_PIN.exec(block);
  if (!match) {
    throw new Error(
      "README Quick Start block has no PINCHY_VERSION=vX.Y.Z pin to read",
    );
  }
  return match[1];
}

/**
 * Reads every tracked pin out of the raw file contents supplied by the
 * caller.
 * @param {object} files
 * @param {string} files.readme - README.md contents
 * @param {string} files.envExample - .env.example contents
 * @param {string} files.digitalOcean - marketplace/digitalocean/template.json contents
 * @param {string} files.caprover - marketplace/caprover/pinchy.yml contents
 * @returns {Record<string, string>} label -> pinned version
 */
export function collectMainVersionPins({
  readme,
  envExample,
  digitalOcean,
  caprover,
}) {
  return {
    "README quick-start": readReadmeVersionPin(readme),
    ".env.example": readPinchyVersionFromEnv(envExample),
    "DigitalOcean marketplace template": readMarketplaceVersion(digitalOcean),
    "CapRover marketplace template": readCaproverVersion(caprover),
  };
}

/**
 * @param {Record<string, string>} pins - label -> pinned version
 * @param {string} latestVersion - the latest published release tag
 * @returns {Array<{label: string, pinned: string, latest: string}>}
 */
export function findStaleVersionPins(pins, latestVersion) {
  return Object.entries(pins)
    .filter(([, pinned]) => isFullMinorBehind(pinned, latestVersion))
    .map(([label, pinned]) => ({ label, pinned, latest: latestVersion }));
}

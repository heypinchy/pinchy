/**
 * Pure functions for the Pinchy release script.
 * No side effects — all I/O happens in release.mjs.
 */

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Validates and normalizes a version string.
 * Accepts "0.3.0" or "v0.3.0", returns "0.3.0".
 * @param {string} input
 * @returns {string}
 */
export function parseAndValidateVersion(input) {
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid version: "${input}". Expected format: 1.2.3`);
  }
  return version;
}

/**
 * Returns the contents of a package.json file with the version field updated.
 * Preserves formatting and trailing newline.
 * @param {string} content - raw file contents
 * @param {string} version - new version (e.g. "0.3.0")
 * @returns {string}
 */
export function bumpPackageJson(content, version) {
  const hasTrailingNewline = content.endsWith("\n");
  const pkg = JSON.parse(content);
  pkg.version = version;
  const result = JSON.stringify(pkg, null, 2);
  return hasTrailingNewline ? result + "\n" : result;
}

/**
 * Returns the git tag name for a version (e.g. "v0.3.0").
 * @param {string} version
 * @returns {string}
 */
export function buildTagName(version) {
  return `v${version}`;
}

/**
 * Returns the git commit message for a release.
 * @param {string} version
 * @returns {string}
 */
export function buildCommitMessage(version) {
  return `chore: release v${version}`;
}

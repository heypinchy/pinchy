/**
 * Keeps the marketplace listing templates' pinned Pinchy version in lockstep
 * with `.env.example` (the project's declared "version users should run").
 *
 * Marketplace images bake a concrete version (e.g. the DigitalOcean snapshot
 * pre-pulls that version's images). Left to drift, a new install would start
 * several versions behind the current release. `.env.example` already carries
 * the canonical pin (`PINCHY_VERSION=vX.Y.Z`, bumped by `pnpm release`), so the
 * marketplace templates anchor to it and the release script bumps them together.
 *
 * Pure functions only — all I/O happens in the callers (release.mjs, the guard
 * test). Mirrors the shape of release-logic.mjs.
 */

const PINCHY_VERSION_LINE = /^PINCHY_VERSION=(.+)$/m;

/**
 * Extracts the `PINCHY_VERSION=vX.Y.Z` value from a .env-style file's contents.
 * @param {string} content
 * @returns {string} the version with its leading 'v' (e.g. "v0.6.0")
 * @throws {Error} if no PINCHY_VERSION= line is present
 */
export function readPinchyVersionFromEnv(content) {
  const match = PINCHY_VERSION_LINE.exec(content);
  if (!match) {
    throw new Error("No PINCHY_VERSION= line found in .env.example");
  }
  return match[1].trim();
}

/**
 * Reads the pinned version from a DigitalOcean Packer template's JSON contents
 * (`variables.application_version`).
 * @param {string} templateJson
 * @returns {string} the version with its leading 'v' (e.g. "v0.6.0")
 * @throws {Error} if the field is missing
 */
export function readMarketplaceVersion(templateJson) {
  const template = JSON.parse(templateJson);
  const version = template?.variables?.application_version;
  if (!version) {
    throw new Error(
      "Packer template has no variables.application_version to read",
    );
  }
  return version;
}

/**
 * Returns the Packer template JSON contents with `application_version` set to
 * `v<version>`. A surgical replace of just that value — like bumpEnvExample —
 * so the rest of the file (formatting, key order, trailing newline) is left
 * byte-for-byte and a release bump produces a one-line diff that never fights
 * Prettier.
 * @param {string} content - raw template.json contents
 * @param {string} version - release version, no 'v' prefix (e.g. "0.6.0")
 * @returns {string}
 * @throws {Error} if the template has no application_version field
 */
export function bumpMarketplaceVersion(content, version) {
  const pattern = /("application_version"\s*:\s*")[^"]*(")/;
  if (!pattern.test(content)) {
    throw new Error(
      'Packer template has no "application_version" field to bump',
    );
  }
  return content.replace(pattern, `$1v${version}$2`);
}

/**
 * Asserts the marketplace template's pinned version equals `.env.example`'s
 * PINCHY_VERSION. `pnpm release` bumps both, so any divergence means a release
 * forgot the marketplace template (or someone hand-edited one of them).
 *
 * @param {string} templateJson - contents of the Packer template
 * @param {string} envExample - contents of .env.example
 * @throws {Error} if the two versions differ
 */
export function assertMarketplaceVersionInSync(templateJson, envExample) {
  const marketplace = readMarketplaceVersion(templateJson);
  const env = readPinchyVersionFromEnv(envExample);
  if (marketplace !== env) {
    throw new Error(
      `Marketplace template version (${marketplace}) is out of sync with ` +
        `.env.example PINCHY_VERSION (${env}).\n` +
        `'pnpm release' bumps both together — they must match. ` +
        `Re-run the release bump or align the marketplace template.`,
    );
  }
}

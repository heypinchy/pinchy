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
 * Reads the pinned version from the CapRover one-click template's YAML
 * contents (the `$$cap_pinchy_version` variable's `defaultValue`). The version
 * variable is the only one with a version-shaped default — the secrets use
 * `$$cap_gen_random_hex(...)` — so a single regex matches it unambiguously.
 * @param {string} templateYaml
 * @returns {string} the version with its leading 'v' (e.g. "v0.6.0")
 * @throws {Error} if no version default is present
 */
export function readCaproverVersion(templateYaml) {
  const match = /defaultValue:\s*['"]?(v\d+\.\d+\.\d+)['"]?/.exec(templateYaml);
  if (!match) {
    throw new Error(
      "CapRover template has no version defaultValue (v X.Y.Z) to read",
    );
  }
  return match[1];
}

/**
 * Returns the CapRover template YAML with the `$$cap_pinchy_version` default
 * set to `v<version>`. Surgical replace of just that value — preserves quoting,
 * formatting, and the trailing newline.
 * @param {string} content - raw CapRover template contents
 * @param {string} version - release version, no 'v' prefix (e.g. "0.6.0")
 * @returns {string}
 * @throws {Error} if no version default is present
 */
export function bumpCaproverVersion(content, version) {
  const pattern = /(defaultValue:\s*['"]?)v\d+\.\d+\.\d+(['"]?)/;
  if (!pattern.test(content)) {
    throw new Error(
      "CapRover template has no version defaultValue (v X.Y.Z) to bump",
    );
  }
  return content.replace(pattern, `$1v${version}$2`);
}

/**
 * Asserts a marketplace template's pinned version equals `.env.example`'s
 * PINCHY_VERSION. `pnpm release` bumps every template, so any divergence means
 * a release forgot one (or someone hand-edited it).
 *
 * @param {string} actualVersion - version read from a template (e.g. "v0.6.0")
 * @param {string} envExample - contents of .env.example
 * @param {string} label - human name of the template, for the error message
 * @throws {Error} if the versions differ
 */
export function assertVersionInSync(actualVersion, envExample, label) {
  const env = readPinchyVersionFromEnv(envExample);
  if (actualVersion !== env) {
    throw new Error(
      `${label} version (${actualVersion}) is out of sync with ` +
        `.env.example PINCHY_VERSION (${env}).\n` +
        `'pnpm release' bumps both together — they must match. ` +
        `Re-run the release bump or align the template.`,
    );
  }
}

/**
 * Drift guard for the DigitalOcean Packer template.
 * @param {string} templateJson - contents of the Packer template
 * @param {string} envExample - contents of .env.example
 */
export function assertMarketplaceVersionInSync(templateJson, envExample) {
  assertVersionInSync(
    readMarketplaceVersion(templateJson),
    envExample,
    "DigitalOcean template",
  );
}

/**
 * Drift guard for the CapRover one-click template.
 * @param {string} templateYaml - contents of the CapRover template
 * @param {string} envExample - contents of .env.example
 */
export function assertCaproverVersionInSync(templateYaml, envExample) {
  assertVersionInSync(
    readCaproverVersion(templateYaml),
    envExample,
    "CapRover template",
  );
}

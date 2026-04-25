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
 * Returns the contents of a .env.example file with PINCHY_VERSION set to the
 * target release tag. Preserves all other lines, comments, and ordering.
 * Throws if PINCHY_VERSION= line is missing — release script should never run
 * against a .env.example that hasn't been prepared for Scope 2.
 *
 * @param {string} content - raw .env.example contents
 * @param {string} version - release version, no 'v' prefix (e.g. "0.5.0")
 * @returns {string}
 */
export function bumpEnvExample(content, version) {
  const pattern = /^PINCHY_VERSION=.*$/m;
  if (!pattern.test(content)) {
    throw new Error(
      "No PINCHY_VERSION= line in .env.example. " +
        "Scope 2 migration incomplete — add it before releasing.",
    );
  }
  return content.replace(pattern, `PINCHY_VERSION=v${version}`);
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

/**
 * Escapes a string for safe inclusion in a RegExp pattern.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Asserts that upgrading.mdx contains a section for the target release.
 *
 * The heading must explicitly reference both the previous version (as
 * "from v<prev>") and the target version (either as "to v<target>" or
 * as "to %%PINCHY_VERSION%%", which is Pinchy's docs convention — the
 * placeholder is replaced at docs-build time by inject-version.sh).
 *
 * Requiring "from v<prev>" prevents a stale heading from a prior release
 * (e.g. "from v0.4.3 to %%PINCHY_VERSION%%") from silently satisfying
 * the gate for the next release.
 *
 * @param {string} mdx - contents of docs/src/content/docs/guides/upgrading.mdx
 * @param {string} prevVersion - previous release, no leading 'v' (e.g. "0.4.4")
 * @param {string} targetVersion - new release, no leading 'v' (e.g. "0.5.0")
 * @throws {Error} if no matching heading is found, or if the section is
 *               missing a '### Breaking changes' or '### Upgrade notes' subsection
 */
export function assertUpgradingSectionExists(mdx, prevVersion, targetVersion) {
  const headingPattern = new RegExp(
    `^##\\s+Upgrading\\s+from\\s+v${escapeRegex(prevVersion)}\\s+to\\s+(v${escapeRegex(targetVersion)}|%%PINCHY_VERSION%%)\\s*$`,
    "m",
  );
  const headingMatch = headingPattern.exec(mdx);
  if (!headingMatch) {
    throw new Error(
      `No upgrade-notes section for v${targetVersion} in upgrading.mdx.\n` +
        `Add a heading:\n\n  ## Upgrading from v${prevVersion} to %%PINCHY_VERSION%%\n\n` +
        `then draft the upgrade notes under it before releasing.`,
    );
  }

  // Slice from the matched heading to the next `## ` heading (or EOF) so
  // subsection checks scan only THIS version entry, not later ones.
  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remainder = mdx.slice(sectionStart);
  const nextHeading = /^## /m.exec(remainder);
  const sectionBody = remainder.slice(0, nextHeading ? nextHeading.index : remainder.length);

  for (const required of ["Breaking changes", "Upgrade notes"]) {
    const subPattern = new RegExp(`^###\\s+${escapeRegex(required)}\\s*$`, "m");
    if (!subPattern.test(sectionBody)) {
      throw new Error(
        `Missing '${required}' subsection in v${targetVersion} entry of upgrading.mdx.\n` +
          `Each upgrade-notes section must contain '### Breaking changes' and '### Upgrade notes'.\n` +
          `Content "None." is fine; absent is not.`,
      );
    }
  }
}

/**
 * Extracts the body of the upgrade-notes section for a release.
 *
 * Finds the `## Upgrading from v<prev> to (v<target>|%%PINCHY_VERSION%%)`
 * heading, returns all content up to the next `## ` heading (nested `###`
 * subheadings are preserved), with `%%PINCHY_VERSION%%` replaced by the
 * resolved `v<target>` string so the output is ready to be used as
 * GitHub Release body content.
 *
 * @param {string} mdx - contents of docs/src/content/docs/guides/upgrading.mdx
 * @param {string} prevVersion - previous release, no leading 'v' (e.g. "0.4.4")
 * @param {string} targetVersion - new release, no leading 'v' (e.g. "0.5.0")
 * @returns {string} section body (trimmed), or empty string if the section is missing
 */
export function extractUpgradeNotes(mdx, prevVersion, targetVersion) {
  const heading = new RegExp(
    `^##\\s+Upgrading\\s+from\\s+v${escapeRegex(prevVersion)}\\s+to\\s+(v${escapeRegex(targetVersion)}|%%PINCHY_VERSION%%)\\s*$`,
    "m",
  );
  const match = heading.exec(mdx);
  if (!match) return "";

  const remainder = mdx.slice(match.index + match[0].length);
  const nextHeading = /^## /m.exec(remainder);
  const body = remainder.slice(0, nextHeading ? nextHeading.index : remainder.length);

  return body.trim().replace(/%%PINCHY_VERSION%%/g, `v${targetVersion}`);
}

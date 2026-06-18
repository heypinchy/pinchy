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
 * Asserts that both package.json versions match the release tag.
 *
 * Regression guard for the v0.5.5 release: it was cut with `gh release create`
 * instead of `pnpm release`, so the `chore: release` version bump never ran and
 * the published images reported `pinchyVersion: 0.5.4` (from packages/web's
 * pkg.version, baked into NEXT_PUBLIC_PINCHY_VERSION at build) despite the
 * v0.5.5 tag. release.yml runs this before pushing any image so the drift fails
 * the workflow cheaply, before any GHCR artifact exists.
 *
 * @param {{ tag: string, pkgVersion: string, webVersion: string }} args
 *   tag — release tag, with or without leading 'v' (e.g. "v0.5.5" or "0.5.5").
 *   pkgVersion — version field of root package.json.
 *   webVersion — version field of packages/web/package.json.
 * @throws {Error} if the tag is not valid semver, or if either package version
 *   does not match the tag.
 */
export function assertVersionMatchesTag({ tag, pkgVersion, webVersion }) {
  const expected = parseAndValidateVersion(tag);
  const mismatches = [];
  if (pkgVersion !== expected) {
    mismatches.push(`  package.json:              ${pkgVersion}`);
  }
  if (webVersion !== expected) {
    mismatches.push(`  packages/web/package.json: ${webVersion}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Tag v${expected} does not match package versions:\n` +
        `${mismatches.join("\n")}\n` +
        `Run 'pnpm release ${expected}' to bump both before tagging.`,
    );
  }
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
 *   missing a '### Breaking changes' or '### Upgrade notes' subsection
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

/**
 * Freezes the in-progress upgrade-notes section at release time.
 *
 * During development the newest section is written as
 * `## Upgrading from v<prev> to %%PINCHY_VERSION%%`, and its body may use
 * `%%PINCHY_VERSION%%` too (e.g. "Starting with %%PINCHY_VERSION%% …"). Once the
 * version is known, this replaces every `%%PINCHY_VERSION%%` occurrence WITHIN
 * that one section (heading + body, sliced to the next `## ` heading) with
 * `v<target>` and returns the rewritten mdx.
 *
 * Why it exists: the v0.5.8 release shipped without freezing its section, so the
 * heading stayed `from v0.5.7 to %%PINCHY_VERSION%%` and the body kept literal
 * placeholders. Because docs/scripts/inject-version.sh resolves
 * `%%PINCHY_VERSION%%` to the *current* build version, those v0.5.8 notes would
 * mis-render as the next release's. The release script calls this so the miss is
 * structurally impossible going forward.
 *
 * Everything outside the matched section is left byte-for-byte: older,
 * already-concrete entries, and the preamble / "Standard upgrade" section whose
 * `%%PINCHY_VERSION%%` is an intentional build-time "latest version" display.
 *
 * @param {string} mdx
 * @param {string} prevVersion - no leading 'v' (e.g. "0.5.8")
 * @param {string} targetVersion - no leading 'v' (e.g. "0.6.0")
 * @returns {string} mdx with the matched section frozen; unchanged if the
 *   heading already uses a concrete target or no matching section exists.
 */
export function finalizeUpgradeSection(mdx, prevVersion, targetVersion) {
  const headingPattern = new RegExp(
    `^##\\s+Upgrading\\s+from\\s+v${escapeRegex(prevVersion)}\\s+to\\s+%%PINCHY_VERSION%%\\s*$`,
    "m",
  );
  const match = headingPattern.exec(mdx);
  if (!match) return mdx;

  const sectionStart = match.index;
  const afterHeading = sectionStart + match[0].length;
  const remainder = mdx.slice(afterHeading);
  const nextHeading = /^## /m.exec(remainder);
  const sectionEnd = nextHeading
    ? afterHeading + nextHeading.index
    : mdx.length;

  const before = mdx.slice(0, sectionStart);
  const section = mdx.slice(sectionStart, sectionEnd);
  const after = mdx.slice(sectionEnd);

  return before + section.replace(/%%PINCHY_VERSION%%/g, `v${targetVersion}`) + after;
}

/**
 * Asserts upgrading.mdx carries no stale `%%PINCHY_VERSION%%` in a released
 * version's section. CI guard (run from scripts/lib/upgrading-mdx-freshness.test.mjs)
 * against the exact drift that shipped in v0.5.8.
 *
 * Invariant enforced:
 *  - At most ONE `## Upgrading from vX to %%PINCHY_VERSION%%` section may exist
 *    (the current/in-progress one). Two means a prior release never froze.
 *  - If one exists, its `from` version must equal the latest released version
 *    (root package.json#version). A lagging `from` means the previous release
 *    forgot to freeze its notes.
 *  - A frozen (concrete-headed `to vY`) section must not keep `%%PINCHY_VERSION%%`
 *    anywhere in its body.
 *
 * Scope: only `## Upgrading from vX to …` sections are inspected. The preamble
 * and the "Standard upgrade" section legitimately render `%%PINCHY_VERSION%%` as
 * a build-time "latest version" display, so they are out of scope.
 *
 * @param {string} mdx
 * @param {string} latestReleasedVersion - no leading 'v' (e.g. "0.5.8")
 * @throws {Error} on a stale, lagging, or duplicated placeholder section
 */
export function assertNoStaleUpgradeSections(mdx, latestReleasedVersion) {
  const latest = parseAndValidateVersion(latestReleasedVersion);
  const headingRe =
    /^##\s+Upgrading\s+from\s+v(\d+\.\d+\.\d+)\s+to\s+(v\d+\.\d+\.\d+|%%PINCHY_VERSION%%)\s*$/gm;

  const matches = [];
  let m;
  while ((m = headingRe.exec(mdx)) !== null) {
    matches.push({ from: m[1], to: m[2], index: m.index, headingLen: m[0].length });
  }

  const placeholderSections = [];
  for (const s of matches) {
    const afterHeading = s.index + s.headingLen;
    const remainder = mdx.slice(afterHeading);
    const nextHeading = /^## /m.exec(remainder);
    const body = remainder.slice(0, nextHeading ? nextHeading.index : remainder.length);

    if (s.to === "%%PINCHY_VERSION%%") {
      placeholderSections.push(s);
    } else if (body.includes("%%PINCHY_VERSION%%")) {
      throw new Error(
        `Stale %%PINCHY_VERSION%% in the frozen "Upgrading from v${s.from} to v${s.to}" section body.\n` +
          `Frozen sections must use the concrete version — replace %%PINCHY_VERSION%% with v${s.to} there.`,
      );
    }
  }

  if (placeholderSections.length > 1) {
    const froms = placeholderSections.map((s) => `v${s.from}`).join(", ");
    throw new Error(
      `Multiple in-progress upgrade sections still use %%PINCHY_VERSION%% (${froms}).\n` +
        `Only the current section (from v${latest}) may — freeze the older one to its released version.`,
    );
  }

  if (placeholderSections.length === 1 && placeholderSections[0].from !== latest) {
    const from = placeholderSections[0].from;
    throw new Error(
      `Stale upgrade-notes section: "Upgrading from v${from} to %%PINCHY_VERSION%%", ` +
        `but the latest released version is v${latest}.\n` +
        `A prior release forgot to freeze its notes. Change that heading to ` +
        `"## Upgrading from v${from} to v${latest}" (and freeze its body placeholders), ` +
        `then add a fresh "## Upgrading from v${latest} to %%PINCHY_VERSION%%" section.`,
    );
  }
}

/**
 * Derives a release-specific "verify on staging" checklist from the target
 * upgrade-notes section.
 *
 * The release-specific verification is bespoke every time — what to click
 * through depends on what actually changed. That list already exists: it's the
 * `#### …` subheadings under `### Breaking changes` and `### Upgrade notes` of
 * this release's section. This turns each into a checklist item, flagging the
 * ones under Breaking changes (which deserve the closest look). A "None."
 * Breaking-changes subsection simply has no `####` and yields no items.
 *
 * Only the target section is scanned (sliced to the next `## ` heading), so a
 * later release's subheadings never leak in. If the section has no `####`
 * subheadings at all, a single generic item is returned so the operator still
 * verifies the notes rather than getting an empty list.
 *
 * @param {string} mdx
 * @param {string} prevVersion - no leading 'v'
 * @param {string} targetVersion - no leading 'v'
 * @returns {Array<{title: string, breaking: boolean}>}
 */
export function deriveStagingChecklist(mdx, prevVersion, targetVersion) {
  const heading = new RegExp(
    `^##\\s+Upgrading\\s+from\\s+v${escapeRegex(prevVersion)}\\s+to\\s+(v${escapeRegex(targetVersion)}|%%PINCHY_VERSION%%)\\s*$`,
    "m",
  );
  const m = heading.exec(mdx);
  if (!m) return [];

  const remainder = mdx.slice(m.index + m[0].length);
  const nextH2 = /^## /m.exec(remainder);
  const sectionBody = remainder.slice(0, nextH2 ? nextH2.index : remainder.length);

  const subRe = /^###\s+(.+?)\s*$/gm;
  const subs = [];
  let sm;
  while ((sm = subRe.exec(sectionBody)) !== null) {
    subs.push({ name: sm[1].trim(), index: sm.index, len: sm[0].length });
  }

  const items = [];
  for (let i = 0; i < subs.length; i++) {
    const bodyStart = subs[i].index + subs[i].len;
    const bodyEnd = i + 1 < subs.length ? subs[i + 1].index : sectionBody.length;
    const body = sectionBody.slice(bodyStart, bodyEnd);
    const breaking = /^breaking changes$/i.test(subs[i].name);
    const hRe = /^####\s+(.+?)\s*$/gm;
    let hm;
    while ((hm = hRe.exec(body)) !== null) {
      items.push({ title: hm[1].trim(), breaking });
    }
  }

  if (items.length === 0) {
    return [
      {
        title: `Verify the changes described in the v${targetVersion} upgrade notes`,
        breaking: false,
      },
    ];
  }
  return items;
}

/**
 * Checks a staging attestation against the commit being released.
 *
 * The release-specific staging verification can't be made fraud-proof, but it
 * can be anchored to the exact code: the operator passes the SHA they verified
 * on staging (`:next` builds the tip of main), and it must match HEAD — the
 * commit about to be tagged. A short SHA that prefixes HEAD is accepted
 * (`git rev-parse --short`). Returns a result rather than throwing so callers
 * decide whether to warn or hard-fail.
 *
 * @param {{verifiedSha?: string, headSha?: string}} args
 * @returns {{ok: boolean, message: string}}
 */
export function checkReleaseVerification({ verifiedSha, headSha }) {
  const v = (verifiedSha || "").trim().toLowerCase();
  const h = (headSha || "").trim().toLowerCase();
  if (!v) {
    return {
      ok: false,
      message:
        "No staging attestation provided. Verify this commit on staging, then pass --verified=$(git rev-parse HEAD).",
    };
  }
  if (v.length < 7) {
    return {
      ok: false,
      message: `Attestation SHA "${verifiedSha}" is too short — pass at least 7 chars (use $(git rev-parse HEAD)).`,
    };
  }
  if (!(h.startsWith(v) || v.startsWith(h))) {
    return {
      ok: false,
      message: `Attestation SHA ${verifiedSha} does not match HEAD ${headSha} — you verified a different commit than you're releasing.`,
    };
  }
  return { ok: true, message: `Staging attestation matches HEAD (${h.slice(0, 12)}).` };
}

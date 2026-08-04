/**
 * Pure functions for the Pinchy release script.
 * No side effects — all I/O happens in release.mjs.
 *
 * Every function below that reads a section of upgrading.mdx cuts it at the
 * next `## ` — and must therefore go through `maskFencedBlocks`, because a
 * quoted `## ` inside a code fence is a sample, not a heading. See
 * mdx-fences.mjs for what each caller loses when it does not.
 */

import { maskFencedBlocks, sliceSectionBody } from "./mdx-fences.mjs";

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
 * Splits a DECLARED version — what a package.json says this tree is — into its
 * released part and whether it is a development tree.
 *
 * Distinct from `parseAndValidateVersion`, which validates a release TARGET and
 * must stay strict: you cannot release `0.10.0-dev`. This one is the reader for
 * `package.json#version`, which since #1044 carries `<next>-dev` at every moment
 * that is not a release commit.
 *
 * `-dev` is the only accepted suffix. Allowing `-rc.1` or `-alpha` would turn
 * "is this a development tree?" into a semver-precedence question in every
 * consumer; it is meant to be a string check.
 *
 * @param {string} input - e.g. "0.9.1", "v0.9.1" or "0.10.0-dev"
 * @returns {{released: string, isDev: boolean}}
 */
export function parseDeclaredVersion(input) {
  if (typeof input !== "string") {
    throw new Error(`Not a version string: ${JSON.stringify(input)}`);
  }
  const value = input.startsWith("v") ? input.slice(1) : input;
  if (SEMVER_RE.test(value)) return { released: value, isDev: false };
  if (/^\d+\.\d+\.\d+-dev$/.test(value)) {
    return { released: value.slice(0, -4), isDev: true };
  }
  throw new Error(
    `Invalid declared version: "${input}". Expected "1.2.3" or "1.2.3-dev".`,
  );
}

/**
 * Orders two RELEASE versions (no leading 'v', no suffix). Negative / zero /
 * positive, like a comparator: `compareVersions("0.9.0", "0.10.0") < 0`.
 *
 * Throws on anything it cannot order. It used to `.split(".").map(Number)` and
 * fall through to 0, which meant `compareVersions("0.10.0-dev", "0.9.1")`
 * answered "equal" — `[0, 10, NaN]`, and every NaN comparison is false. A
 * silent equal from a comparator is worse than a crash: `assertNoStaleUpgrade
 * Sections` picks the newest release with this, and a wrong "equal" there is a
 * guard reporting green on a version it never read.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    if (typeof v !== "string" || !SEMVER_RE.test(v)) {
      throw new Error(
        `Not an orderable release version: ${JSON.stringify(v)}. ` +
          `Strip any \`-dev\` suffix with parseDeclaredVersion first.`,
      );
    }
    return v.split(".").map(Number);
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
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
  const mask = maskFencedBlocks(mdx);
  const headingMatch = headingPattern.exec(mask);
  if (!headingMatch) {
    throw new Error(
      `No upgrade-notes section for v${targetVersion} in upgrading.mdx.\n` +
        `Add a heading:\n\n  ## Upgrading from v${prevVersion} to %%PINCHY_VERSION%%\n\n` +
        `then draft the upgrade notes under it before releasing.`,
    );
  }

  // Slice from the matched heading to the next `## ` heading (or EOF) so
  // subsection checks scan only THIS version entry, not later ones. The MASKED
  // body is what gets scanned: a `### Upgrade notes` quoted inside a fence is a
  // sample and must not satisfy the gate.
  const sectionStart = headingMatch.index + headingMatch[0].length;
  const sectionBody = sliceSectionBody(mask, sectionStart, mask).body;

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
  const mask = maskFencedBlocks(mdx);
  const match = heading.exec(mask);
  if (!match) return "";

  // Boundary from the mask, bytes from the original. Cutting on an unmasked
  // `^## ` is how v0.9.1's published release body came to end at a dangling
  // ```` ```markdown ````, with the remediation the note exists to give
  // missing entirely.
  const { body } = sliceSectionBody(mdx, match.index + match[0].length, mask);

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
  const mask = maskFencedBlocks(mdx);
  const match = headingPattern.exec(mask);
  if (!match) return mdx;

  const sectionStart = match.index;
  const afterHeading = sectionStart + match[0].length;
  // A `## ` inside a fence used to end the section here, leaving every
  // `%%PINCHY_VERSION%%` after it unfrozen in a section that has shipped —
  // which `assertNoStaleUpgradeSections` then could not see, for the same
  // reason. Both read the mask now.
  const { end: sectionEnd } = sliceSectionBody(mdx, afterHeading, mask);

  const before = mdx.slice(0, sectionStart);
  const section = mdx.slice(sectionStart, sectionEnd);
  const after = mdx.slice(sectionEnd);

  return (
    before + section.replace(/%%PINCHY_VERSION%%/g, `v${targetVersion}`) + after
  );
}

/**
 * Opens the NEXT cycle's upgrade-notes section, directly above the one the
 * release just froze.
 *
 * `finalizeUpgradeSection` above closes a section; nothing used to open the
 * next one. The runbook asked the first upgrade-affecting change after a
 * release to add it by hand, and nobody did — so the next commit that wrote an
 * upgrade note appended it to the end of the file, which is the FROZEN section
 * of the release that already shipped. Measured on main on 2026-08-01, seven
 * released sections had drifted from their tag that way, three of them by
 * gaining a whole `####` note describing behaviour that release does not have.
 * See AGENTS.md § "A Released Upgrade Section Is Immutable".
 *
 * The skeleton is not headings-only, deliberately. Two existing guards read the
 * newest section: the #370 prune guard requires `docker image prune` in it, and
 * the next release's own `assertUpgradingSectionExists` requires both `###`
 * subsections. An empty skeleton would turn the branch red on every release.
 * Its body keeps `%%PINCHY_VERSION%%` where the next version belongs, which is
 * exactly what `finalizeUpgradeSection` freezes at the next cut.
 *
 * Everything outside the inserted block is byte-identical, and the call is
 * idempotent: a section already headed `from v<target> to %%PINCHY_VERSION%%`
 * means the author opened it by hand, so this is a no-op.
 *
 * Because the skeleton satisfies `assertUpgradingSectionExists` by
 * construction, `assertUpgradeNotesWritten` below refuses to release it
 * unedited — otherwise this function would have quietly removed the gate that
 * used to make somebody write the notes.
 *
 * @param {string} mdx - contents AFTER finalizeUpgradeSection has run
 * @param {string} prevVersion - the "from" of the section just frozen, no 'v'
 * @param {string} targetVersion - the version just released, no 'v'
 * @returns {string} mdx with the next section opened; unchanged if it already
 *   exists or if the frozen anchor section cannot be found.
 */
export function openNextUpgradeSection(mdx, prevVersion, targetVersion) {
  const alreadyOpen = new RegExp(
    `^##\\s+Upgrading\\s+from\\s+v${escapeRegex(targetVersion)}\\s+to\\s+%%PINCHY_VERSION%%\\s*$`,
    "m",
  );
  const mask = maskFencedBlocks(mdx);
  if (alreadyOpen.test(mask)) return mdx;

  const anchor = new RegExp(
    `^##\\s+Upgrading\\s+from\\s+v${escapeRegex(prevVersion)}\\s+to\\s+v${escapeRegex(targetVersion)}\\s*$`,
    "m",
  );
  const match = anchor.exec(mask);
  if (!match) return mdx;

  return (
    mdx.slice(0, match.index) +
    buildNextUpgradeSkeleton(targetVersion) +
    "\n\n" +
    mdx.slice(match.index)
  );
}

/**
 * The skeleton `openNextUpgradeSection` inserts, as one string.
 *
 * Exported because two callers must agree on it byte-for-byte: the release run
 * that writes it, and `assertUpgradeNotesWritten` below, which refuses to
 * release a section still carrying it verbatim.
 *
 * @param {string} openedAfterVersion - the version just released, no 'v'
 * @returns {string} heading + body, no trailing newline
 */
export function buildNextUpgradeSkeleton(openedAfterVersion) {
  return [
    `## Upgrading from v${openedAfterVersion} to %%PINCHY_VERSION%%`,
    "",
    "### Breaking changes",
    "",
    "None so far.",
    "",
    "### Upgrade notes",
    "",
    "Upgrade with the standard flow:",
    "",
    "```bash",
    "cd /opt/pinchy",
    `sed -i 's/PINCHY_VERSION=v${openedAfterVersion}/PINCHY_VERSION=%%PINCHY_VERSION%%/' .env`,
    "docker compose pull && docker compose up -d && docker image prune -f",
    "```",
  ].join("\n");
}

/**
 * Asserts the section about to be released is not still the auto-generated
 * skeleton.
 *
 * This restores a safety net that `openNextUpgradeSection` would otherwise have
 * removed. Before it, a release where nobody wrote upgrade notes failed at the
 * gate — there was no `from v<just-released>` section at all, and
 * `assertUpgradingSectionExists` said so. Now the section always exists, and it
 * satisfies that check by construction: it has both `###` subsections and a
 * plausible-looking body. So the release would sail through and publish an
 * auto-generated page describing nothing.
 *
 * The comparison is exact (modulo surrounding blank lines): any edit at all
 * counts as somebody having looked. Writing "None." under Breaking changes is
 * a decision; leaving "None so far." is the skeleton's own placeholder.
 *
 * @param {string} mdx
 * @param {string} prevVersion - the "from" of the section being released, no
 *   'v'. It is also the version the skeleton was opened after, which is what
 *   makes the regenerated comparison text exact.
 * @param {string} targetVersion - the version being released, no 'v'
 * @throws {Error} when the section is byte-identical to the skeleton
 */
export function assertUpgradeNotesWritten(mdx, prevVersion, targetVersion) {
  const heading = new RegExp(
    `^##\\s+Upgrading\\s+from\\s+v${escapeRegex(prevVersion)}\\s+to\\s+(v${escapeRegex(targetVersion)}|%%PINCHY_VERSION%%)\\s*$`,
    "m",
  );
  const mask = maskFencedBlocks(mdx);
  const match = heading.exec(mask);
  if (!match) return; // assertUpgradingSectionExists owns that failure.

  const { body } = sliceSectionBody(mdx, match.index + match[0].length, mask);

  const skeleton = buildNextUpgradeSkeleton(prevVersion);
  const skeletonBody = skeleton.slice(skeleton.indexOf("\n") + 1);
  if (body.trim() !== skeletonBody.trim()) return;

  throw new Error(
    `The v${targetVersion} section of upgrading.mdx is still the skeleton that\n` +
      `\`pnpm release v${prevVersion}\` generated — nobody has written this release's\n` +
      `upgrade notes.\n\n` +
      `Describe what changed for someone running v${prevVersion} today. If this release\n` +
      `genuinely needs no action beyond the standard flow, say so in the section — a\n` +
      `deliberate "None." reads differently from an untouched template, and only one\n` +
      `of the two tells a reader anything.`,
  );
}

/**
 * Asserts upgrading.mdx carries no stale `%%PINCHY_VERSION%%` in a released
 * version's section. CI guard (run from scripts/lib/upgrading-mdx-freshness.test.mjs)
 * against the exact drift that shipped in v0.5.8.
 *
 * Invariant enforced:
 *  - At most ONE `## Upgrading from vX to %%PINCHY_VERSION%%` section may exist
 *    (the current/in-progress one). Two means a prior release never froze.
 *  - If one exists, its `from` version must equal the latest released version.
 *    A lagging `from` means the previous release forgot to freeze its notes.
 *  - A frozen (concrete-headed `to vY`) section must not keep `%%PINCHY_VERSION%%`
 *    anywhere in its body.
 *
 * "Latest released version" is the NEWER of `latestReleasedVersion` (root
 * package.json#version) and the newest frozen `to vY` heading in the file — NOT
 * package.json alone. Since releases are cut on a `release/X.Y` branch, only
 * that branch gets the version bump; `main` deliberately stays on the previous
 * number until its own next cut. So after v0.9.0 shipped, main's package.json
 * still said 0.8.0 while its newest frozen section already said v0.9.0, and
 * reading package.json alone made the correct next section — `from v0.9.0` —
 * impossible to open. That is not hypothetical: it is why nobody opened one,
 * and why d7ea428d's upgrade note landed inside the frozen v0.9.0 section.
 * Taking the newer of the two keeps the v0.5.8 miss caught (there the lagging
 * side is the FILE, so package.json wins) and works on both branches.
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
  // A `-dev` version is not a released version, so it contributes nothing to
  // "the newest released version" and the frozen sections answer on their own.
  // The max() below was the workaround for a package.json that LAGGED the
  // releases (#1028); since #1044 it LEADS them, and a number that leads must
  // not be mistaken for a release that shipped.
  const declared = parseDeclaredVersion(latestReleasedVersion);
  const pkgLatest = declared.isDev ? [] : [declared.released];
  const headingRe =
    /^##\s+Upgrading\s+from\s+v(\d+\.\d+\.\d+)\s+to\s+(v\d+\.\d+\.\d+|%%PINCHY_VERSION%%)\s*$/gm;

  const mask = maskFencedBlocks(mdx);
  const matches = [];
  let m;
  while ((m = headingRe.exec(mask)) !== null) {
    matches.push({
      from: m[1],
      to: m[2],
      index: m.index,
      headingLen: m[0].length,
    });
  }

  // The newest version this file already records as released.
  const frozenTos = matches
    .filter((s) => s.to !== "%%PINCHY_VERSION%%")
    .map((s) => s.to.slice(1));
  const candidates = [...pkgLatest, ...frozenTos];
  if (candidates.length === 0) return; // nothing released yet — nothing to be stale against
  const latest = candidates.reduce((a, b) =>
    compareVersions(a, b) >= 0 ? a : b,
  );

  const placeholderSections = [];
  for (const s of matches) {
    // The real body, not the masked one: the placeholder this looks for can
    // legitimately sit after a fenced sample, and reading a truncated body is
    // exactly how the v0.5.8 miss this guard exists for came back.
    const { body } = sliceSectionBody(mdx, s.index + s.headingLen, mask);

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

  if (
    placeholderSections.length === 1 &&
    placeholderSections[0].from !== latest
  ) {
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
  const mask = maskFencedBlocks(mdx);
  const m = heading.exec(mask);
  if (!m) return [];

  // Scanned on the mask throughout: a `####` quoted inside a fence is a sample,
  // and a checklist item nobody can verify is worse than one fewer item. Real
  // headings are byte-identical in the mask, so the titles are unaffected.
  const sectionBody = sliceSectionBody(mask, m.index + m[0].length, mask).body;

  const subRe = /^###\s+(.+?)\s*$/gm;
  const subs = [];
  let sm;
  while ((sm = subRe.exec(sectionBody)) !== null) {
    subs.push({ name: sm[1].trim(), index: sm.index, len: sm[0].length });
  }

  const items = [];
  for (let i = 0; i < subs.length; i++) {
    const bodyStart = subs[i].index + subs[i].len;
    const bodyEnd =
      i + 1 < subs.length ? subs[i + 1].index : sectionBody.length;
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
 * on staging (which runs this branch's candidate image — `:next` for main,
 * `:rc-X.Y` for a release branch, see `stagingImageTagForBranch`), and it must
 * match HEAD — the commit about to be tagged. Note that both of those are
 * MOVING tags, which is why the attestation is a SHA and not a tag name: only
 * `:sha-<short>` names an exact ref. A short SHA that prefixes HEAD is accepted
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
  return {
    ok: true,
    message: `Staging attestation matches HEAD (${h.slice(0, 12)}).`,
  };
}

/**
 * Reads the `--verified` attestation off an argv array.
 *
 * Accepts both `--verified=<sha>` and `--verified <sha>`. The second form is a
 * plausible typo, and answering it with `undefined` would report "no
 * attestation provided" at somebody who provided one — so it is parsed rather
 * than ignored. A bare `--verified` followed by another flag (or nothing)
 * yields `""`, which the verification gate rejects as too short; that is a
 * refusal with a reason, not a silent skip.
 *
 * @param {string[]} argv
 * @returns {string|undefined} the value, or undefined when the flag is absent
 */
export function parseVerifiedSha(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const i = args.findIndex(
    (a) => a === "--verified" || a.startsWith("--verified="),
  );
  if (i === -1) return undefined;
  const arg = args[i];
  if (arg.startsWith("--verified=")) return arg.slice("--verified=".length);
  const next = args[i + 1];
  return next === undefined || next.startsWith("-") ? "" : next;
}

/**
 * Checks that CI is green **for the commit being released**, not merely green
 * somewhere on the branch.
 *
 * The old gate read `gh run list --limit 1` and looked only at `conclusion`, so
 * a green run for an earlier commit passed it — including the case where the
 * working tree is clean but HEAD was never pushed, meaning the tag could carry
 * code CI never built (#1085).
 *
 * Runs arrive newest-first, so the newest run whose `headSha` is HEAD is the
 * verdict that counts: a re-run that went red after a green one must lose, and
 * an unrelated newer run for a different commit must not hide HEAD's own.
 *
 * @param {{runs: unknown, headSha: string, branch: string}} args
 * @returns {{ok: boolean, message: string}}
 */
export function checkCiGreenForHead({ runs, headSha, branch }) {
  const head = (headSha || "").trim().toLowerCase();
  if (!head) {
    return {
      ok: false,
      message:
        "Could not resolve HEAD, so CI's verdict cannot be tied to a commit.",
    };
  }
  if (!Array.isArray(runs)) {
    return {
      ok: false,
      message:
        "Could not read CI runs from `gh run list` — check that gh is authenticated and the workflow name is right.",
    };
  }

  const short = head.slice(0, 12);
  const forHead = runs.filter(
    (r) =>
      r &&
      String(r.headSha || "")
        .trim()
        .toLowerCase() === head,
  );
  // Order explicitly rather than trusting `gh`'s newest-first output. Nothing
  // pins that order, and if it ever flipped, a red re-run would be ignored in
  // favour of an earlier green — the exact failure this gate exists to close,
  // arriving silently.
  //
  // An unreadable timestamp never displaces the incumbent, so the fallback is
  // gh's own order. That already follows from every comparison against NaN
  // being false; the explicit guard states the policy instead of leaving it to
  // be re-derived by whoever refactors this next.
  const run = forHead.reduce((best, r) => {
    const rt = Date.parse(r.createdAt ?? "");
    const bt = Date.parse(best.createdAt ?? "");
    if (Number.isNaN(rt) || Number.isNaN(bt)) return best;
    return rt > bt ? r : best;
  }, forHead[0]);
  if (!run) {
    return {
      ok: false,
      message:
        `No CI run found for HEAD ${short} on ${branch}. ` +
        "Push the commit and let CI finish before releasing — a green run for an " +
        "older commit does not cover the code you are about to tag.",
    };
  }
  // An unfinished run has NO conclusion, and `gh` spells that as the empty
  // string rather than null (verified against real output). Reading "" as a
  // verdict would tell the operator to fix CI when the only thing to do is
  // wait, so anything falsy means not-finished-yet.
  const conclusion = String(run.conclusion ?? "").trim();
  // The run URL is already in the payload we fetch. A gate that reports a
  // problem and then makes the operator hunt through the Actions tab for the
  // run it is holding a link to is hiding its own evidence.
  const link = run.url ? ` ${run.url}` : "";
  if (!conclusion) {
    return {
      ok: false,
      message: `CI for HEAD ${short} is still running (status: ${run.status || "unknown"}). Wait for it to finish.${link}`,
    };
  }
  if (conclusion !== "success") {
    return {
      ok: false,
      message: `CI for HEAD ${short} on ${branch} concluded "${run.conclusion}". Fix CI before releasing.${link}`,
    };
  }
  return { ok: true, message: `CI green for HEAD ${short}` };
}

/**
 * Returns README.md contents with BOTH quick-start version pins updated to the
 * release tag.
 *
 * The README's quick-start install carries two pins, and they only work as a
 * pair:
 *
 *   1. the `raw.githubusercontent.com/heypinchy/pinchy/v<X.Y.Z>/docker-compose.yml`
 *      URL the reader curls, and
 *   2. the `PINCHY_VERSION=v<X.Y.Z>` line written into `.env`, which is what
 *      that compose file resolves its image tags from (it refuses to start
 *      without it: `PINCHY_VERSION:?set PINCHY_VERSION in .env`).
 *
 * Bumping only the URL is worse than bumping neither. A stale URL at least
 * yields a self-consistent older install; a fresh compose file pinned to an
 * older image tag starts happily and silently runs the *previous* release
 * against the new release's topology. So a missing pin is an error rather than
 * a no-op — the pin that is not there is the one that drifts. Without bumping
 * here the URL sat on v0.5.7 through both the v0.5.8 and v0.6.0 releases, so
 * new users pulled a stale compose file.
 *
 * The release tag is created later in the same release run, so the bumped URL
 * resolves once pushed (same pattern as the marketplace template pins).
 *
 * @param {string} content - raw README.md contents
 * @param {string} version - release version, no 'v' prefix (e.g. "0.6.0")
 * @returns {string}
 * @throws {Error} if either pin is missing
 */
export function bumpReadmeQuickstartPins(content, version) {
  const composeUrlPin =
    /(raw\.githubusercontent\.com\/heypinchy\/pinchy\/)v\d+\.\d+\.\d+(\/docker-compose\.yml)/g;
  if (!composeUrlPin.test(content)) {
    throw new Error(
      "No pinned docker-compose URL in README.md " +
        "(raw.githubusercontent.com/heypinchy/pinchy/v<version>/docker-compose.yml). " +
        "The quick-start install pin moved or was removed — update bumpReadmeQuickstartPins.",
    );
  }
  const envVersionPin = /(PINCHY_VERSION=)v\d+\.\d+\.\d+/g;
  if (!envVersionPin.test(content)) {
    throw new Error(
      "No PINCHY_VERSION=v<version> pin in README.md. The quick-start writes it " +
        "into .env and docker-compose.yml refuses to start without it, so the " +
        "quick-start cannot be correct without this line — update bumpReadmeQuickstartPins.",
    );
  }
  return content
    .replace(composeUrlPin, `$1v${version}$2`)
    .replace(envVersionPin, `$1v${version}`);
}

/** Matches a release branch: `release/X.Y` with numeric major/minor (e.g. `release/0.9`). */
const RELEASE_BRANCH_RE = /^release\/\d+\.\d+$/;

/**
 * Whether a release may be cut from the given branch.
 *
 * Releases come off trunk (`main`) or a per-minor `release/X.Y` branch — nothing
 * else (feature branches, worktree branches, a detached HEAD which reports as an
 * empty string). Deliberately stricter than the `release/**` glob that triggers
 * CI and pre-release: those may run on any release-ish branch, but the tag cut is
 * the gated act and only the canonical `release/X.Y` shape may perform it.
 *
 * @param {string} branch - current branch name (`git branch --show-current`)
 * @returns {boolean}
 */
export function isReleasableBranch(branch) {
  return branch === "main" || RELEASE_BRANCH_RE.test(branch);
}

/**
 * The moving image tag that pre-release.yml pushes for a branch.
 *
 * Staging tracks `:next` for `main`. A release branch must NOT push `:next` or it
 * would flip staging between trunk and the release candidate; instead each
 * `release/X.Y` gets its own `rc-X.Y` moving tag so two concurrent release
 * branches never clobber each other's candidate image. The immutable
 * `:sha-<short>` tag is pushed alongside in both cases (in the workflow).
 *
 * Mirrors — and is the single source of truth for — the `scripts/moving-tag.mjs`
 * wrapper the workflow invokes. Kept tolerant of odd release-branch names (any
 * remaining `/` collapses to `-`) so a candidate push never fails on the tag
 * name; the strict `release/X.Y` gate lives in `isReleasableBranch` at cut time.
 *
 * @param {string} refName - the branch short name (`$GITHUB_REF_NAME`), e.g. "main" or "release/0.9"
 * @returns {string} e.g. "next" or "rc-0.9"
 */
export function movingTagForRef(refName) {
  if (refName === "main") return "next";
  const rc = refName.replace(/^release\//, "").replaceAll("/", "-");
  return `rc-${rc}`;
}

/**
 * The image tag staging must be pinned to in order to verify a cut from this
 * branch — `next` for `main`, `rc-X.Y` for `release/X.Y`.
 *
 * The preflight used to print `:next` unconditionally. `:next` tracks `main`,
 * so for a release-branch candidate that names an image hundreds of commits
 * away from the one about to be tagged: you verify something else entirely and
 * the gate reports nothing. Observed while preparing v0.9.1, the first patch
 * cut from a release branch.
 *
 * Delegates to `movingTagForRef` rather than re-deriving, so the pin the
 * operator verifies is by construction the tag pre-release.yml pushed.
 *
 * Returns `null` for anything else — a feature branch, a detached HEAD, an odd
 * `release/…` shape. Two different reasons converge on that answer, and it is
 * worth not conflating them: for `feature/foo` pre-release.yml publishes
 * nothing, so `movingTagForRef`'s tolerant fallback (`rc-feature-foo`) would
 * name an image that does not exist; for `release/0.9/hotfix` an image really
 * is published — the trigger is `release/**`, not `release/X.Y` — but
 * `isReleasableBranch` refuses to cut a tag from that branch at all, so the
 * pin is moot. That tolerance is right for a workflow which must never fail on
 * a tag name, and wrong for an instruction a human is about to follow. `null`
 * lets the preflight stay silent about a pin rather than name one.
 *
 * @param {string} branch - current branch name (`git branch --show-current`)
 * @returns {string|null} e.g. "next", "rc-0.9", or null if no release can be cut here
 */
export function stagingImageTagForBranch(branch) {
  if (!isReleasableBranch(branch)) return null;
  return movingTagForRef(branch);
}

/**
 * The preflight's staging-pin line, as data: which tag to verify on, plus the
 * parenthetical that makes it actionable.
 *
 * Lives here rather than inline in `release-preflight.mjs` because the string
 * IS the bug this fixes — a hardcoded `:next` sent a release-branch cut to
 * verify `main`. A hardcoded sentence in a script is asserted by nothing; the
 * script keeps only the printing.
 *
 * `main` deliberately gets no exact-ref note even though `:next` moves just as
 * much: staging is *designed* to track `:next` continuously (see CONTRIBUTING
 * § "Testing a release candidate"), so telling the operator to pin a SHA there
 * would argue against the setup that works. The note exists for the case the
 * default pin gets wrong — a release branch, whose candidate image staging
 * does not follow.
 *
 * @param {string} branch - current branch name (`git branch --show-current`)
 * @param {string|null} headSha - full HEAD sha, or null if git could not answer
 * @returns {{tag: string|null, note: string|null}}
 */
export function stagingPinAdvice(branch, headSha) {
  const tag = stagingImageTagForBranch(branch);

  if (tag === null) {
    // Not "no image exists" — `release/0.9/hotfix` has one. The honest reason
    // is that no release may be cut from here, so there is nothing to pin for.
    return {
      tag: null,
      note: `(no release can be cut from ${branch || "a detached HEAD"} — releases come off main or release/X.Y, so there is no candidate to pin)`,
    };
  }

  if (tag === movingTagForRef("main")) return { tag, note: null };

  // rc-X.Y is a moving tag: it is whatever was pushed to the branch last, which
  // is not necessarily the commit being attested.
  const exact = headSha ? `:sha-${headSha.slice(0, 12)}` : ":sha-<short12>";
  return {
    tag,
    note: `(:${tag} moves with every push to ${branch} — pin ${exact} to nail this exact ref. Never :next; it tracks main.)`,
  };
}

/**
 * Releases that sit between the "from" version and the target — i.e. releases
 * this cut would silently skip.
 *
 * This exists because of what the v0.9.0 cycle did to `main`. The release was
 * cut on `release/0.9`, so the version bump and the frozen upgrade section
 * live only on that branch: `main`'s package.json still says 0.8.0, and
 * `git describe` on `main` still answers v0.8.0 because the v0.9.0 tag is not
 * an ancestor. Both of the inputs the release machinery trusts therefore agree
 * on a "from" version that is one release out of date — and agreeing is
 * exactly what makes it invisible.
 *
 * The consequence is not a bad version number. It is that
 * `finalizeUpgradeSection` would relabel the v0.9.0 upgrade notes as the
 * v0.10.0 delta, so a user upgrading FROM v0.9.0 would find no section
 * addressed to them and the pgvector/Knowledge-Base notes would be attributed
 * to the wrong release. Docs are the only place that damage shows up, and by
 * then they are published.
 *
 * The full tag list is the one input that cannot be fooled by which branch you
 * are standing on.
 *
 * @param {string} prevVersion - the "from" version, no leading 'v' (e.g. "0.8.0")
 * @param {string} targetVersion - the version being cut, no leading 'v'
 * @param {string[]} allTags - every tag in the repo (`git tag --list`)
 * @returns {string[]} skipped release tags, oldest first (empty = ok)
 */
export function findSkippedReleases(prevVersion, targetVersion, allTags) {
  const cmp = compareVersions;
  return allTags
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1))
    .filter((v) => cmp(v, prevVersion) > 0 && cmp(v, targetVersion) < 0)
    .sort(cmp)
    .map((v) => `v${v}`);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAndValidateVersion,
  bumpPackageJson,
  buildTagName,
  buildCommitMessage,
  assertUpgradingSectionExists,
  extractUpgradeNotes,
  bumpEnvExample,
  assertVersionMatchesTag,
  finalizeUpgradeSection,
  assertNoStaleUpgradeSections,
  deriveStagingChecklist,
  checkReleaseVerification,
  bumpReadmeComposePin,
} from "./release-logic.mjs";

// parseAndValidateVersion

test("parseAndValidateVersion accepts valid semver", () => {
  assert.equal(parseAndValidateVersion("0.3.0"), "0.3.0");
});

test("parseAndValidateVersion strips leading v", () => {
  assert.equal(parseAndValidateVersion("v0.3.0"), "0.3.0");
});

test("parseAndValidateVersion rejects non-semver string", () => {
  assert.throws(() => parseAndValidateVersion("invalid"), /invalid version/i);
});

test("parseAndValidateVersion rejects incomplete semver", () => {
  assert.throws(() => parseAndValidateVersion("1.0"), /invalid version/i);
});

test("parseAndValidateVersion rejects empty string", () => {
  assert.throws(() => parseAndValidateVersion(""), /invalid version/i);
});

// bumpPackageJson

test("bumpPackageJson updates version field", () => {
  const input = JSON.stringify({ name: "pinchy", version: "0.2.0" }, null, 2);
  const output = bumpPackageJson(input, "0.3.0");
  assert.equal(JSON.parse(output).version, "0.3.0");
});

test("bumpPackageJson preserves other fields", () => {
  const input = JSON.stringify({ name: "pinchy", version: "0.2.0", private: true }, null, 2);
  const output = bumpPackageJson(input, "0.3.0");
  const parsed = JSON.parse(output);
  assert.equal(parsed.name, "pinchy");
  assert.equal(parsed.private, true);
});

test("bumpPackageJson preserves trailing newline", () => {
  const input = '{"name":"pinchy","version":"0.2.0"}\n';
  const output = bumpPackageJson(input, "0.3.0");
  assert.ok(output.endsWith("\n"));
});

// buildTagName

test("buildTagName prefixes version with v", () => {
  assert.equal(buildTagName("0.3.0"), "v0.3.0");
});

// assertVersionMatchesTag — the v0.5.5 regression guard. `gh release create`
// skipped the `pnpm release` version bump, so the published images reported a
// stale `pinchyVersion` (0.5.4) despite the v0.5.5 tag. This function is the
// build-time gate that release.yml runs before pushing any image.

test("assertVersionMatchesTag passes when both package versions match the tag", () => {
  assert.doesNotThrow(() =>
    assertVersionMatchesTag({
      tag: "v0.5.5",
      pkgVersion: "0.5.5",
      webVersion: "0.5.5",
    }),
  );
});

test("assertVersionMatchesTag accepts a tag without the leading v", () => {
  assert.doesNotThrow(() =>
    assertVersionMatchesTag({
      tag: "0.5.5",
      pkgVersion: "0.5.5",
      webVersion: "0.5.5",
    }),
  );
});

test("assertVersionMatchesTag throws when the root package.json version is stale", () => {
  assert.throws(
    () =>
      assertVersionMatchesTag({
        tag: "v0.5.5",
        pkgVersion: "0.5.4",
        webVersion: "0.5.5",
      }),
    /package\.json/,
  );
});

test("assertVersionMatchesTag throws when the web package.json version is stale", () => {
  assert.throws(
    () =>
      assertVersionMatchesTag({
        tag: "v0.5.5",
        pkgVersion: "0.5.5",
        webVersion: "0.5.4",
      }),
    /packages\/web\/package\.json/,
  );
});

test("assertVersionMatchesTag error names the offending version and suggests pnpm release", () => {
  assert.throws(
    () =>
      assertVersionMatchesTag({
        tag: "v0.5.5",
        pkgVersion: "0.5.4",
        webVersion: "0.5.4",
      }),
    (err) => {
      assert.match(err.message, /0\.5\.4/);
      assert.match(err.message, /pnpm release 0\.5\.5/);
      return true;
    },
  );
});

test("assertVersionMatchesTag rejects a malformed tag", () => {
  assert.throws(
    () =>
      assertVersionMatchesTag({
        tag: "not-a-version",
        pkgVersion: "0.5.5",
        webVersion: "0.5.5",
      }),
    /invalid version/i,
  );
});

// buildCommitMessage

test("buildCommitMessage follows conventional commit format", () => {
  assert.equal(buildCommitMessage("0.3.0"), "chore: release v0.3.0");
});

// assertUpgradingSectionExists

test("assertUpgradingSectionExists accepts %%PINCHY_VERSION%% placeholder", () => {
  const mdx = [
    "## Upgrading from v0.4.4 to %%PINCHY_VERSION%%",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
    "### Upgrade notes",
    "",
    "Notes go here.",
  ].join("\n");
  assert.doesNotThrow(() => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"));
});

test("assertUpgradingSectionExists accepts concrete target version", () => {
  const mdx = [
    "## Upgrading from v0.4.4 to v0.5.0",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
    "### Upgrade notes",
    "",
    "Notes.",
  ].join("\n");
  assert.doesNotThrow(() => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"));
});

test("assertUpgradingSectionExists rejects missing section", () => {
  const mdx = "## Upgrading from v0.4.3 to v0.4.4\n\nOld notes.\n";
  assert.throws(
    () => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"),
    /no upgrade-notes section for v0\.5\.0/i,
  );
});

test("assertUpgradingSectionExists rejects stale section (wrong 'from' version)", () => {
  const mdx = "## Upgrading from v0.4.3 to %%PINCHY_VERSION%%\n\nStale.\n";
  assert.throws(
    () => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"),
    /no upgrade-notes section for v0\.5\.0/i,
  );
});

test("assertUpgradingSectionExists is whitespace-tolerant in the heading", () => {
  const mdx =
    "##   Upgrading  from  v0.4.4  to  %%PINCHY_VERSION%%  \n\n### Breaking changes\n\nNone.\n\n### Upgrade notes\n\nNotes.\n";
  assert.doesNotThrow(() => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"));
});

test("assertUpgradingSectionExists error message suggests the heading to add", () => {
  const mdx = "(empty)";
  assert.throws(
    () => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"),
    /## Upgrading from v0\.4\.4 to %%PINCHY_VERSION%%/,
  );
});

test("assertUpgradingSectionExists accepts a section with both required subsections", () => {
  const mdx = `## Upgrading from v0.4.4 to %%PINCHY_VERSION%%

### Breaking changes

None.

### Upgrade notes

Standard upgrade.
`;
  assert.doesNotThrow(() => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"));
});

test("assertUpgradingSectionExists rejects a section missing the Breaking changes subsection", () => {
  const mdx = `## Upgrading from v0.4.4 to %%PINCHY_VERSION%%

### Upgrade notes

Standard upgrade — no required action.
`;
  assert.throws(
    () => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"),
    /Missing.*Breaking changes.*subsection/i,
  );
});

test("assertUpgradingSectionExists rejects a section missing the Upgrade notes subsection", () => {
  const mdx = `## Upgrading from v0.4.4 to %%PINCHY_VERSION%%

### Breaking changes

None.
`;
  assert.throws(
    () => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"),
    /Missing.*Upgrade notes.*subsection/i,
  );
});

test("assertUpgradingSectionExists doesn't satisfy current section with later section's subsections", () => {
  // The current v0.5.0 section has no subsections; a LATER (older) version
  // section happens to contain both required subsections. The slice logic
  // must stop at the next `## ` heading so the older section's subsections
  // never satisfy the current check.
  const mdx = `## Upgrading from v0.4.4 to %%PINCHY_VERSION%%

No subsections here.

## Upgrading from v0.4.3 to v0.4.4

### Breaking changes

None.

### Upgrade notes

Older notes.
`;
  assert.throws(
    () => assertUpgradingSectionExists(mdx, "0.4.4", "0.5.0"),
    /Missing.*Breaking changes.*subsection/i,
  );
});

// extractUpgradeNotes

test("extractUpgradeNotes returns the body under the matching section", () => {
  const mdx = [
    "# Upgrading Pinchy",
    "",
    "## Upgrading from v0.4.4 to %%PINCHY_VERSION%%",
    "",
    "First note.",
    "Second note.",
    "",
    "## Upgrading from v0.4.3 to v0.4.4",
    "",
    "Older note.",
  ].join("\n");
  const result = extractUpgradeNotes(mdx, "0.4.4", "0.5.0");
  assert.match(result, /First note\./);
  assert.match(result, /Second note\./);
  assert.doesNotMatch(result, /Older note\./);
});

test("extractUpgradeNotes replaces %%PINCHY_VERSION%% with v<target>", () => {
  const mdx = [
    "## Upgrading from v0.4.4 to %%PINCHY_VERSION%%",
    "",
    "See the %%PINCHY_VERSION%% changelog for details.",
  ].join("\n");
  const result = extractUpgradeNotes(mdx, "0.4.4", "0.5.0");
  assert.match(result, /v0\.5\.0 changelog/);
  assert.doesNotMatch(result, /%%PINCHY_VERSION%%/);
});

test("extractUpgradeNotes returns empty string when section is missing", () => {
  const mdx = "# Upgrading Pinchy\n\n## Upgrading from v0.4.2 to v0.4.3\n\nOld.\n";
  assert.equal(extractUpgradeNotes(mdx, "0.4.4", "0.5.0"), "");
});

test("extractUpgradeNotes handles section at end of file (no trailing heading)", () => {
  const mdx = [
    "## Upgrading from v0.4.4 to v0.5.0",
    "",
    "Only section — no trailing heading.",
  ].join("\n");
  const result = extractUpgradeNotes(mdx, "0.4.4", "0.5.0");
  assert.match(result, /Only section/);
});

test("extractUpgradeNotes preserves nested ### subheadings but stops at next ## heading", () => {
  const mdx = [
    "## Upgrading from v0.4.4 to %%PINCHY_VERSION%%",
    "",
    "### Breaking changes",
    "Changed.",
    "",
    "### Migrations",
    "Migrated.",
    "",
    "## Upgrading from v0.4.3 to v0.4.4",
    "",
    "Older.",
  ].join("\n");
  const result = extractUpgradeNotes(mdx, "0.4.4", "0.5.0");
  assert.match(result, /### Breaking changes/);
  assert.match(result, /### Migrations/);
  assert.doesNotMatch(result, /Older\./);
});

test("extractUpgradeNotes trims leading and trailing whitespace", () => {
  const mdx = [
    "## Upgrading from v0.4.4 to v0.5.0",
    "",
    "",
    "Content.",
    "",
    "",
    "## Upgrading from v0.4.3 to v0.4.4",
  ].join("\n");
  const result = extractUpgradeNotes(mdx, "0.4.4", "0.5.0");
  assert.equal(result, "Content.");
});

// bumpEnvExample

test("bumpEnvExample updates PINCHY_VERSION line, preserves everything else", () => {
  const input = `# Required
PINCHY_VERSION=v0.4.4

# Optional
# DB_PASSWORD=
# BETTER_AUTH_SECRET=
`;
  const expected = `# Required
PINCHY_VERSION=v0.5.0

# Optional
# DB_PASSWORD=
# BETTER_AUTH_SECRET=
`;
  assert.equal(bumpEnvExample(input, "0.5.0"), expected);
});

test("bumpEnvExample throws when PINCHY_VERSION line is missing", () => {
  const input = `# Only optional vars, no PINCHY_VERSION
# DB_PASSWORD=
`;
  assert.throws(() => bumpEnvExample(input, "0.5.0"), /No PINCHY_VERSION= line in \.env\.example/);
});

test("bumpEnvExample preserves order and other variables when many exist", () => {
  const input = `# Comment
FOO=bar
PINCHY_VERSION=v0.4.4
# Another comment
BAZ=qux
# PINCHY_VERSION looks like this in a comment — must not match
`;
  const output = bumpEnvExample(input, "0.5.0");
  assert.ok(output.includes("PINCHY_VERSION=v0.5.0"));
  assert.ok(output.includes("FOO=bar"));
  assert.ok(output.includes("BAZ=qux"));
  assert.ok(output.includes("# PINCHY_VERSION looks like this in a comment"));
  // Exactly one PINCHY_VERSION= line (not counting the commented one)
  const matches = output.match(/^PINCHY_VERSION=/gm) || [];
  assert.equal(matches.length, 1);
});

// bumpReadmeComposePin — keeps the README quick-start curl pin on the released
// tag so a fresh one-command install is reproducible. Orphaned before this:
// the pin sat on v0.5.7 through the v0.5.8 and v0.6.0 releases.

test("bumpReadmeComposePin updates the pinned docker-compose tag, preserves the rest", () => {
  const input = `## Quick Start

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/heypinchy/pinchy/v0.5.7/docker-compose.yml -o docker-compose.yml
docker compose up -d
\`\`\`
`;
  const expected = `## Quick Start

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/heypinchy/pinchy/v0.6.0/docker-compose.yml -o docker-compose.yml
docker compose up -d
\`\`\`
`;
  assert.equal(bumpReadmeComposePin(input, "0.6.0"), expected);
});

test("bumpReadmeComposePin throws when the pinned docker-compose URL is missing", () => {
  const input = `## Quick Start\n\nNo pinned compose URL here.\n`;
  assert.throws(
    () => bumpReadmeComposePin(input, "0.6.0"),
    /No pinned docker-compose URL in README\.md/,
  );
});

test("bumpReadmeComposePin replaces any prior version, not just a specific one", () => {
  const input =
    "curl https://raw.githubusercontent.com/heypinchy/pinchy/v0.4.12/docker-compose.yml -o docker-compose.yml\n";
  assert.equal(
    bumpReadmeComposePin(input, "0.6.0"),
    "curl https://raw.githubusercontent.com/heypinchy/pinchy/v0.6.0/docker-compose.yml -o docker-compose.yml\n",
  );
});

// finalizeUpgradeSection — freezes the in-progress section at release time so
// the v0.5.8 "section left on %%PINCHY_VERSION%%" miss can't recur.

test("finalizeUpgradeSection freezes the heading placeholder to v<target>", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
    "### Upgrade notes",
    "",
    "Standard upgrade.",
  ].join("\n");
  const out = finalizeUpgradeSection(mdx, "0.5.8", "0.6.0");
  assert.match(out, /^## Upgrading from v0\.5\.8 to v0\.6\.0$/m);
  assert.doesNotMatch(out, /%%PINCHY_VERSION%%/);
});

test("finalizeUpgradeSection freezes body placeholders within the section too", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
    "### Upgrade notes",
    "",
    "Starting with %%PINCHY_VERSION%% the thing changes.",
    "",
    "```bash",
    "sed -i 's/PINCHY_VERSION=v0.5.8/PINCHY_VERSION=%%PINCHY_VERSION%%/' .env",
    "```",
  ].join("\n");
  const out = finalizeUpgradeSection(mdx, "0.5.8", "0.6.0");
  assert.match(out, /Starting with v0\.6\.0 the thing changes\./);
  assert.match(out, /PINCHY_VERSION=v0\.6\.0/);
  assert.doesNotMatch(out, /%%PINCHY_VERSION%%/);
});

test("finalizeUpgradeSection leaves older concrete sections untouched", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "Current notes.",
    "",
    "## Upgrading from v0.5.7 to v0.5.8",
    "",
    "Older notes mentioning v0.5.8.",
  ].join("\n");
  const out = finalizeUpgradeSection(mdx, "0.5.8", "0.6.0");
  assert.match(out, /## Upgrading from v0\.5\.7 to v0\.5\.8/);
  assert.match(out, /Older notes mentioning v0\.5\.8\./);
});

test("finalizeUpgradeSection does not touch placeholders outside the matched section (preamble)", () => {
  const mdx = [
    "## Standard upgrade",
    "",
    "Bump to PINCHY_VERSION=%%PINCHY_VERSION%% (build-time display).",
    "",
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "Current section.",
  ].join("\n");
  const out = finalizeUpgradeSection(mdx, "0.5.8", "0.6.0");
  // The build-time display placeholder in "Standard upgrade" must survive.
  assert.match(out, /PINCHY_VERSION=%%PINCHY_VERSION%% \(build-time display\)/);
  // The version section heading is frozen.
  assert.match(out, /## Upgrading from v0\.5\.8 to v0\.6\.0/);
});

test("finalizeUpgradeSection is a no-op when the heading already uses a concrete target", () => {
  const mdx = "## Upgrading from v0.5.8 to v0.6.0\n\nAlready concrete.\n";
  assert.equal(finalizeUpgradeSection(mdx, "0.5.8", "0.6.0"), mdx);
});

test("finalizeUpgradeSection is a no-op when no matching section exists", () => {
  const mdx = "## Upgrading from v0.5.6 to v0.5.7\n\nUnrelated.\n";
  assert.equal(finalizeUpgradeSection(mdx, "0.5.8", "0.6.0"), mdx);
});

// assertNoStaleUpgradeSections — CI guard against unfrozen / drifted sections.

test("assertNoStaleUpgradeSections passes when the single placeholder section matches latest", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "Current.",
    "",
    "## Upgrading from v0.5.7 to v0.5.8",
    "",
    "Older.",
  ].join("\n");
  assert.doesNotThrow(() => assertNoStaleUpgradeSections(mdx, "0.5.8"));
});

test("assertNoStaleUpgradeSections passes with zero placeholder sections (post-release state)", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to v0.6.0",
    "",
    "Frozen current.",
    "",
    "## Upgrading from v0.5.7 to v0.5.8",
    "",
    "Older.",
  ].join("\n");
  assert.doesNotThrow(() => assertNoStaleUpgradeSections(mdx, "0.6.0"));
});

test("assertNoStaleUpgradeSections throws when the placeholder section's 'from' lags the latest tag (the v0.5.8 miss)", () => {
  const mdx = [
    "## Upgrading from v0.5.7 to %%PINCHY_VERSION%%",
    "",
    "These are really v0.5.8 notes that were never frozen.",
  ].join("\n");
  assert.throws(
    () => assertNoStaleUpgradeSections(mdx, "0.5.8"),
    /stale upgrade-notes section/i,
  );
});

test("assertNoStaleUpgradeSections throws on two placeholder sections", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "Current.",
    "",
    "## Upgrading from v0.5.7 to %%PINCHY_VERSION%%",
    "",
    "Unfrozen older.",
  ].join("\n");
  assert.throws(
    () => assertNoStaleUpgradeSections(mdx, "0.5.8"),
    /multiple in-progress upgrade sections/i,
  );
});

test("assertNoStaleUpgradeSections throws when a frozen (concrete) section body still has a placeholder", () => {
  const mdx = [
    "## Upgrading from v0.5.7 to v0.5.8",
    "",
    "Starting with %%PINCHY_VERSION%% something happens.",
  ].join("\n");
  assert.throws(
    () => assertNoStaleUpgradeSections(mdx, "0.5.8"),
    /stale %%PINCHY_VERSION%%/i,
  );
});

test("assertNoStaleUpgradeSections ignores placeholders outside version sections (preamble / Standard upgrade)", () => {
  const mdx = [
    "## Standard upgrade",
    "",
    "Bump to PINCHY_VERSION=%%PINCHY_VERSION%% (build-time display).",
    "",
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "Current.",
  ].join("\n");
  assert.doesNotThrow(() => assertNoStaleUpgradeSections(mdx, "0.5.8"));
});

// deriveStagingChecklist — turns the target section's `####` subheadings into a
// release-specific "verify on staging" checklist (the bespoke gate). Breaking
// changes are flagged; "None." breaking changes yield no breaking items.

const CHECKLIST_MDX = [
  "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
  "",
  "### Breaking changes",
  "",
  "#### Telegram and web no longer share one conversation",
  "",
  "Body.",
  "",
  "### Upgrade notes",
  "",
  "#### Multiple chats per agent",
  "",
  "Body.",
  "",
  "#### Sturdier streaming and reconnects",
  "",
  "Body.",
  "",
  "## Upgrading from v0.5.7 to v0.5.8",
  "",
  "#### Older feature (must NOT leak into the v0.6.0 checklist)",
].join("\n");

test("deriveStagingChecklist extracts #### subheadings as items, flagging breaking ones", () => {
  const items = deriveStagingChecklist(CHECKLIST_MDX, "0.5.8", "0.6.0");
  assert.deepEqual(items, [
    { title: "Telegram and web no longer share one conversation", breaking: true },
    { title: "Multiple chats per agent", breaking: false },
    { title: "Sturdier streaming and reconnects", breaking: false },
  ]);
});

test("deriveStagingChecklist does not leak a later section's subheadings", () => {
  const items = deriveStagingChecklist(CHECKLIST_MDX, "0.5.8", "0.6.0");
  assert.ok(!items.some((i) => /Older feature/.test(i.title)));
});

test("deriveStagingChecklist yields no breaking items when Breaking changes is 'None.'", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
    "### Upgrade notes",
    "",
    "#### A nice improvement",
    "",
    "Body.",
  ].join("\n");
  const items = deriveStagingChecklist(mdx, "0.5.8", "0.6.0");
  assert.deepEqual(items, [{ title: "A nice improvement", breaking: false }]);
});

test("deriveStagingChecklist falls back to a generic item when there are no #### subheadings", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to %%PINCHY_VERSION%%",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
    "### Upgrade notes",
    "",
    "Standard upgrade — just bump and pull.",
  ].join("\n");
  const items = deriveStagingChecklist(mdx, "0.5.8", "0.6.0");
  assert.equal(items.length, 1);
  assert.equal(items[0].breaking, false);
  assert.match(items[0].title, /upgrade notes/i);
});

test("deriveStagingChecklist returns [] when the target section is missing", () => {
  const mdx = "## Upgrading from v0.5.6 to v0.5.7\n\n#### Unrelated\n";
  assert.deepEqual(deriveStagingChecklist(mdx, "0.5.8", "0.6.0"), []);
});

test("deriveStagingChecklist works on a concrete (post-finalize) target heading too", () => {
  const mdx = [
    "## Upgrading from v0.5.8 to v0.6.0",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
    "### Upgrade notes",
    "",
    "#### A feature",
    "",
    "Body.",
  ].join("\n");
  const items = deriveStagingChecklist(mdx, "0.5.8", "0.6.0");
  assert.deepEqual(items, [{ title: "A feature", breaking: false }]);
});

// checkReleaseVerification — ties the staging attestation to the exact commit.

test("checkReleaseVerification ok when verified SHA matches HEAD", () => {
  const r = checkReleaseVerification({
    verifiedSha: "abc1234def567",
    headSha: "abc1234def567",
  });
  assert.equal(r.ok, true);
});

test("checkReleaseVerification accepts a short verified SHA that prefixes HEAD", () => {
  const r = checkReleaseVerification({
    verifiedSha: "abc1234",
    headSha: "abc1234def5678901234",
  });
  assert.equal(r.ok, true);
});

test("checkReleaseVerification fails on SHA mismatch", () => {
  const r = checkReleaseVerification({
    verifiedSha: "abc1234",
    headSha: "def9999000",
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /match|head/i);
});

test("checkReleaseVerification fails when no attestation is provided", () => {
  const r = checkReleaseVerification({ verifiedSha: "", headSha: "abc1234def" });
  assert.equal(r.ok, false);
  assert.match(r.message, /--verified|attestation|staging/i);
});

test("checkReleaseVerification rejects a too-short verified SHA", () => {
  const r = checkReleaseVerification({ verifiedSha: "abc", headSha: "abc1234def567" });
  assert.equal(r.ok, false);
});

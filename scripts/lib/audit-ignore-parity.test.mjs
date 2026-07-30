import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  parseOsvIgnoredVulns,
  parseAuditIgnoreGhsas,
  validateAuditIgnoreParity,
  todayIso,
} from "./audit-ignore-parity.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const GHSA = "GHSA-mh99-v99m-4gvg";

/** @param {Partial<{id: string, reason: string | null, ignoreUntil: string | null}>} [over] */
function osvEntry(over = {}) {
  return {
    id: GHSA,
    reason: "unreachable — fixed internal globs only",
    ignoreUntil: "2099-01-01",
    ...over,
  };
}

test("parseOsvIgnoredVulns reads id, reason and ignoreUntil out of every block", () => {
  const toml = [
    '# a comment mentioning id = "GHSA-not-an-entry"',
    "",
    "[[IgnoredVulns]]",
    'id = "GHSA-aaaa-bbbb-cccc"',
    'reason = "first"',
    "",
    "[[IgnoredVulns]]",
    'id = "GHSA-dddd-eeee-ffff"',
    "ignoreUntil = 2026-10-25",
    'reason = "second"',
  ].join("\n");

  assert.deepEqual(parseOsvIgnoredVulns(toml), [
    { id: "GHSA-aaaa-bbbb-cccc", reason: "first", ignoreUntil: null },
    { id: "GHSA-dddd-eeee-ffff", reason: "second", ignoreUntil: "2026-10-25" },
  ]);
});

test("parseOsvIgnoredVulns does not let a following table bleed into an entry", () => {
  // Without a terminator the `id` of a later table would be read as this
  // entry's second field — and TOML's last-wins would silently retarget the
  // acceptance at a different advisory.
  const toml = [
    "[[IgnoredVulns]]",
    'id = "GHSA-aaaa-bbbb-cccc"',
    'reason = "kept"',
    "",
    "[SomethingElse]",
    'reason = "not part of the entry above"',
  ].join("\n");

  assert.deepEqual(parseOsvIgnoredVulns(toml), [
    { id: "GHSA-aaaa-bbbb-cccc", reason: "kept", ignoreUntil: null },
  ]);
});

test("parseAuditIgnoreGhsas returns [] when the key is absent", () => {
  // The pre-#993 state. `[]` is the honest reading: nothing is ignored.
  assert.deepEqual(parseAuditIgnoreGhsas({}), []);
  assert.deepEqual(parseAuditIgnoreGhsas({ pnpm: {} }), []);
});

test("parseAuditIgnoreGhsas throws rather than shrugging at a non-array", () => {
  // A string here would iterate character by character and report nonsense.
  assert.throws(
    () =>
      parseAuditIgnoreGhsas({ pnpm: { auditConfig: { ignoreGhsas: GHSA } } }),
    /must be an array/,
  );
});

test("a pnpm-side ignore backed by a live osv entry is clean", () => {
  assert.deepEqual(
    validateAuditIgnoreParity({
      osvEntries: [osvEntry()],
      ghsaIgnores: [GHSA],
      today: "2026-07-30",
    }),
    [],
  );
});

test("an ignoreGhsas id with no osv entry fails — nothing says what was accepted", () => {
  const errors = validateAuditIgnoreParity({
    osvEntries: [],
    ghsaIgnores: [GHSA],
    today: "2026-07-30",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no \[\[IgnoredVulns\]\] entry/);
  assert.match(errors[0], new RegExp(GHSA));
});

test("an expired osv entry fails while pnpm audit would still stay silent", () => {
  // The whole reason this guard exists: on the expiry date osv-scanner
  // re-opens the question and pnpm audit cannot, because pnpm has no
  // ignoreUntil. Without this rule the two configs diverge by construction.
  const errors = validateAuditIgnoreParity({
    osvEntries: [osvEntry({ ignoreUntil: "2026-10-25" })],
    ghsaIgnores: [GHSA],
    today: "2026-10-25",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expired on 2026-10-25/);
});

test("the day before expiry is still clean", () => {
  assert.deepEqual(
    validateAuditIgnoreParity({
      osvEntries: [osvEntry({ ignoreUntil: "2026-10-25" })],
      ghsaIgnores: [GHSA],
      today: "2026-10-24",
    }),
    [],
  );
});

test("an osv entry with no ignoreUntil fails for a pnpm-side ignore", () => {
  const errors = validateAuditIgnoreParity({
    osvEntries: [osvEntry({ ignoreUntil: null })],
    ghsaIgnores: [GHSA],
    today: "2026-07-30",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no ignoreUntil/);
});

test("an osv entry with an empty reason fails", () => {
  const errors = validateAuditIgnoreParity({
    osvEntries: [osvEntry({ reason: "   " })],
    ghsaIgnores: [GHSA],
    today: "2026-07-30",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no reason/);
});

test("a non-GHSA id in ignoreGhsas fails — pnpm matches GHSA ids only", () => {
  const errors = validateAuditIgnoreParity({
    osvEntries: [osvEntry({ id: "CVE-2026-1234" })],
    ghsaIgnores: ["CVE-2026-1234"],
    today: "2026-07-30",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a GHSA id/);
});

test("a duplicate ignoreGhsas entry fails", () => {
  const errors = validateAuditIgnoreParity({
    osvEntries: [osvEntry()],
    ghsaIgnores: [GHSA, GHSA],
    today: "2026-07-30",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /twice/);
});

test("osv-only acceptances are NOT required to appear in ignoreGhsas", () => {
  // The astro advisories live in docs/pnpm-lock.yaml and the openclaw one is a
  // devDependency; `pnpm audit --prod` at the root reports neither. Mirroring
  // them would silence a scanner about findings it never emits.
  assert.deepEqual(
    validateAuditIgnoreParity({
      osvEntries: [osvEntry(), osvEntry({ id: "GHSA-4g3v-8h47-v7g6" })],
      ghsaIgnores: [GHSA],
      today: "2026-07-30",
    }),
    [],
  );
});

test("the repo's own osv-scanner.toml and package.json agree, today", () => {
  const toml = readFileSync(join(REPO_ROOT, "osv-scanner.toml"), "utf8");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  const errors = validateAuditIgnoreParity({
    osvEntries: parseOsvIgnoredVulns(toml),
    ghsaIgnores: parseAuditIgnoreGhsas(pkg),
    today: todayIso(),
  });

  assert.deepEqual(errors, [], errors.join("\n"));
});

test("the repo's ignoreGhsas is not empty — the release gate needs the entry", () => {
  // Guards the pinchy#993 regression directly: dropping the entry makes
  // `pnpm audit --audit-level=high --prod` fail and no release can be cut,
  // which is a state nothing else in CI reports (osv-scanner stays green).
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(
    parseAuditIgnoreGhsas(pkg).includes(GHSA),
    `${GHSA} must stay in pnpm.auditConfig.ignoreGhsas until the residual ` +
      `minimatch@3/@5 lines have a compatible upstream fix — without it the ` +
      `release audit gate fails on an advisory osv-scanner.toml accepts.`,
  );
});

test("the brace-expansion reason names every route it accepts", () => {
  // The reason string is what osv-scanner prints; the rationale comment above
  // it is printed nowhere. pinchy#993's own argument — "an acceptance that
  // does not name a path it accepts is not an acceptance of that path" —
  // applies to the machine-readable record first.
  const toml = readFileSync(join(REPO_ROOT, "osv-scanner.toml"), "utf8");
  const entry = parseOsvIgnoredVulns(toml).find((e) => e.id === GHSA);
  assert.ok(entry, `${GHSA} entry missing from osv-scanner.toml`);
  for (const route of ["archiver", "gaxios", "config-array"]) {
    assert.match(entry.reason ?? "", new RegExp(route));
  }
});

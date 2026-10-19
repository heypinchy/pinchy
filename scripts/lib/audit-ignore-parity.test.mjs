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
  parseLockfileGraph,
  findUnnamedRoutes,
  scannedLockfiles,
  findAuditJobs,
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
  // A docs/pnpm-lock.yaml finding (the id below is one of the astro advisories
  // accepted there until #851) and a devDependency like braces are both
  // invisible to `pnpm audit --prod` at the root. Mirroring them would silence
  // a scanner about findings it never emits.
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

test("an empty ignoreGhsas is clean — retiring the last pnpm-side acceptance is allowed", () => {
  // The repo's state since GHSA-mh99-v99m-4gvg was retired: osv-scanner still
  // accepts advisories pnpm audit never reports, and nothing is mirrored. The
  // check is one-directional, so this must not read as drift — a guard that
  // demanded a non-empty list would push someone to keep a stale silencer of
  // the release gate alive, which is the failure this file exists to stop.
  assert.deepEqual(
    validateAuditIgnoreParity({
      osvEntries: [osvEntry({ id: "GHSA-4g3v-8h47-v7g6" })],
      ghsaIgnores: [],
      today: "2026-10-17",
    }),
    [],
  );
});

test("parseOsvIgnoredVulns reads headers carrying a trailing comment or inner whitespace", () => {
  // Both are valid TOML and osv-scanner honours them. A header regex anchored
  // on the bare `[[IgnoredVulns]]` skipped them, and with them the whole entry:
  // the acceptance stayed live in CI while every rule in this file was blind
  // to it.
  const toml = [
    "[[IgnoredVulns]] # dev-only",
    'id = "GHSA-aaaa-bbbb-cccc"',
    'reason = "commented header"',
    "",
    "[[ IgnoredVulns ]]",
    'id = "GHSA-dddd-eeee-ffff"',
    'reason = "spaced header"',
    "",
    "  [[IgnoredVulns]]\t",
    'id = "GHSA-gggg-hhhh-iiii"',
    'reason = "indented header"',
  ].join("\n");

  assert.deepEqual(
    parseOsvIgnoredVulns(toml).map((e) => e.id),
    ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff", "GHSA-gggg-hhhh-iiii"],
  );
});

test("parseOsvIgnoredVulns throws on an IgnoredVulns header it cannot read", () => {
  // A quoted key is valid TOML too. Skipping it would be the same silent miss
  // as the comment case, so a header the parser does not understand is an
  // error, not an absence.
  const toml = ['[["IgnoredVulns"]]', 'id = "GHSA-aaaa-bbbb-cccc"'].join("\n");
  assert.throws(() => parseOsvIgnoredVulns(toml), /\[\["IgnoredVulns"\]\]/);
});

test("parseOsvIgnoredVulns throws on an entry with no readable id", () => {
  // `continue` here used to drop the entry without a word. An entry osv-scanner
  // honours under an id this parser cannot read is still an acceptance.
  const toml = ["[[IgnoredVulns]]", "id = 'GHSA-aaaa-bbbb-cccc'"].join("\n");
  assert.throws(() => parseOsvIgnoredVulns(toml), /no readable id/);
});

test("parseOsvIgnoredVulns reads every entry of the repo's own osv-scanner.toml", () => {
  // The "agree today" test above can only be as good as this parse. An entry
  // the parser skipped — a header or reason written in a TOML form it does not
  // read, say — would be invisible to every rule here, so find the entries
  // independently, with a deliberately looser reading than the parser's, and
  // require that each one came back with an id and a reason.
  const toml = readFileSync(join(REPO_ROOT, "osv-scanner.toml"), "utf8");
  const looseIds = looseIgnoredVulnIds(toml);
  const entries = parseOsvIgnoredVulns(toml);
  assert.ok(
    looseIds.length > 0,
    "osv-scanner.toml has no [[IgnoredVulns]] entries",
  );
  const parsed = new Set(entries.map((e) => e.id));
  const skipped = looseIds.filter((id) => !parsed.has(id));
  assert.equal(
    entries.length,
    looseIds.length,
    `parseOsvIgnoredVulns skipped ${skipped.join(", ") || "(an entry with no id)"} — ` +
      `osv-scanner still honours it, so every rule in this file is blind to it.`,
  );
  for (const entry of entries) {
    assert.match(entry.id, /^(GHSA|CVE|MAL)-/);
    assert.ok(
      (entry.reason ?? "").trim().length > 0,
      `${entry.id} has no reason`,
    );
  }
});

test("the loose header reading in the test above sees what the strict one missed", () => {
  // The count above is only an independent check if it is looser than the
  // parser. Pin that with the exact shapes the parser once skipped.
  const toml = [
    "[[IgnoredVulns]] # c",
    'id = "GHSA-aaaa-bbbb-cccc"',
    '[[ "IgnoredVulns" ]]',
    "id = 'GHSA-dddd-eeee-ffff'",
  ].join("\n");
  assert.deepEqual(looseIgnoredVulnIds(toml), [
    "GHSA-aaaa-bbbb-cccc",
    "GHSA-dddd-eeee-ffff",
  ]);
});

/**
 * Every `[[…IgnoredVulns…]]` header, however spelled, mapped to the first
 * id-looking token after it. Deliberately looser than the parser, so a
 * parser miss shows up as a difference rather than as agreement.
 *
 * @param {string} toml
 * @returns {string[]}
 */
function looseIgnoredVulnIds(toml) {
  return toml
    .split(/^[ \t]*\[\[[^\]\n]*IgnoredVulns[^\]\n]*\]\]/m)
    .slice(1)
    .map(
      (block) =>
        block.match(/\b((?:GHSA|CVE|MAL)-[0-9A-Za-z-]+)/)?.[1] ??
        "(no id after header)",
    );
}

// ─── The reason names every route it accepts ─────────────────────────────────

const ROOT_LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    devDependencies:",
  "      eslint-config-next:",
  "        specifier: ^16.0.0",
  "        version: 16.0.0",
  "  packages/web:",
  "    dependencies:",
  "      mammoth:",
  "        specifier: ^1.0.0",
  "        version: 1.12.0",
  "      '@scope/direct':",
  "        specifier: ^1.0.0",
  "        version: 1.0.0",
  "",
  "packages:",
  "",
  "  braces@3.0.3:",
  "    resolution: {integrity: sha512-x}",
  "",
  "snapshots:",
  "",
  "  micromatch@4.0.8:",
  "    dependencies:",
  "      braces: 3.0.3",
  "      picomatch: 4.0.5",
  "",
  "  chokidar@3.6.0:",
  "    optionalDependencies:",
  "      braces: 3.0.3",
  "",
  "  mammoth@1.12.0:",
  "    dependencies:",
  "      argparse: 1.0.10",
  "",
  "  argparse@1.0.10:",
  "    dependencies:",
  "      sprintf-js: 1.0.3",
  "",
  "  '@scope/direct@1.0.0':",
  "    dependencies:",
  "      '@scope/leaf': 2.0.0(react@19.0.0)",
  "",
  "  braces@3.0.3: {}",
  "  sprintf-js@1.0.3: {}",
  "  '@scope/leaf@2.0.0(react@19.0.0)': {}",
].join("\n");

test("parseLockfileGraph reads direct dependencies and every dependent edge", () => {
  const graph = parseLockfileGraph(ROOT_LOCK);
  assert.deepEqual([...graph.direct].sort(), [
    "@scope/direct",
    "eslint-config-next",
    "mammoth",
  ]);
  assert.deepEqual([...(graph.dependents.get("braces") ?? [])].sort(), [
    "chokidar",
    "micromatch",
  ]);
  assert.deepEqual(
    [...(graph.dependents.get("sprintf-js") ?? [])],
    ["argparse"],
  );
  assert.deepEqual(
    [...(graph.dependents.get("@scope/leaf") ?? [])],
    ["@scope/direct"],
  );
});

test("parseLockfileGraph throws on a file that is not a v9 lockfile", () => {
  // An empty graph would make every reason look complete — the guard green on
  // nothing.
  assert.throws(() => parseLockfileGraph("hello: world\n"), /snapshots/);
});

test("a reason naming every package that pulls the vulnerable one in is clean", () => {
  assert.deepEqual(
    findUnnamedRoutes({
      osvEntries: [
        osvEntry({
          id: "GHSA-hp3w-g68c-fv3c",
          reason: "sprintf-js <=1.1.3, reached via mammoth > argparse@1",
        }),
      ],
      lockfiles: [{ path: "pnpm-lock.yaml", text: ROOT_LOCK }],
    }),
    [],
  );
});

test("a reason that omits a route fails and names the missing dependent", () => {
  // The rationale used to name micromatch only. A second dependent in the
  // lockfile is a second way in, and the acceptance says nothing about it.
  const errors = findUnnamedRoutes({
    osvEntries: [
      osvEntry({
        id: "GHSA-vfj7-8cjw-p6xm",
        reason: "braces <=3.0.3, reached via fast-glob > micromatch",
      }),
    ],
    lockfiles: [{ path: "pnpm-lock.yaml", text: ROOT_LOCK }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /GHSA-vfj7-8cjw-p6xm/);
  assert.match(errors[0], /chokidar/);
  assert.doesNotMatch(errors[0], /micromatch/);
});

test("a dependent named only as a prefix of another word does not count", () => {
  // `argparse-ng` is not `argparse`.
  const errors = findUnnamedRoutes({
    osvEntries: [
      osvEntry({ reason: "sprintf-js <=1.1.3, reached via argparse-ng" }),
    ],
    lockfiles: [{ path: "pnpm-lock.yaml", text: ROOT_LOCK }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /argparse/);
});

test("a direct dependency is accepted through its own declaration", () => {
  // astro is declared by docs itself; the route IS the declaration. Its other
  // dependents (Starlight and friends) are peers of the same direct pick.
  assert.deepEqual(
    findUnnamedRoutes({
      osvEntries: [osvEntry({ reason: "mammoth — whatever the story is" })],
      lockfiles: [{ path: "pnpm-lock.yaml", text: ROOT_LOCK }],
    }),
    [],
  );
});

test("a reason whose first word resolves in no scanned lockfile fails", () => {
  // The leading package name is what ties a reason to the lockfile. A reason
  // that starts with prose cannot be checked, so it must not pass as checked.
  const errors = findUnnamedRoutes({
    osvEntries: [osvEntry({ reason: "Reached only via the lint toolchain" })],
    lockfiles: [{ path: "pnpm-lock.yaml", text: ROOT_LOCK }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must begin with the affected package/);
});

test("scannedLockfiles reads the lockfiles vuln-scan hands osv-scanner", () => {
  const ci = [
    "  vuln-scan:",
    "    with:",
    "      scan-args: |-",
    "        --config=./osv-scanner.toml",
    "        --lockfile=./pnpm-lock.yaml",
    "        --lockfile=./docs/pnpm-lock.yaml",
  ].join("\n");
  assert.deepEqual(scannedLockfiles(ci), [
    "pnpm-lock.yaml",
    "docs/pnpm-lock.yaml",
  ]);
});

test("every acceptance in the repo names each route that pulls its package in", () => {
  // AGENTS.md § "Two Scanners, One Acceptance": an acceptance that does not
  // name a path it accepts is not an acceptance of that path. The reason is
  // what osv-scanner prints; the comment above it is printed nowhere. The
  // routes are read from the lockfiles osv-scanner actually scans, so a new
  // dependent of braces or sprintf-js turns this red until the reason says
  // why that path is acceptable too.
  const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const paths = scannedLockfiles(ci);
  assert.ok(paths.length >= 2, `vuln-scan scans ${paths.length} lockfiles`);
  const toml = readFileSync(join(REPO_ROOT, "osv-scanner.toml"), "utf8");
  const errors = findUnnamedRoutes({
    osvEntries: parseOsvIgnoredVulns(toml),
    lockfiles: paths.map((path) => ({
      path,
      text: readFileSync(join(REPO_ROOT, path), "utf8"),
    })),
  });
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("the transitive acceptances really are checked against a route", () => {
  // The rule above is silent for a direct dependency. If the lockfile parse
  // ever stopped seeing edges, every package would look direct-or-absent and
  // the rule would pass on nothing — so pin the two transitive entries #1223
  // wrote down, against the routes their reasons name.
  const read = (p) => readFileSync(join(REPO_ROOT, p), "utf8");
  const graph = parseLockfileGraph(read("pnpm-lock.yaml"));
  assert.ok(graph.dependents.get("braces")?.has("micromatch"));
  assert.ok(graph.dependents.get("sprintf-js")?.has("argparse"));
  assert.ok(!graph.direct.has("braces") && !graph.direct.has("sprintf-js"));
});

// ─── The release gate's own command runs in CI ───────────────────────────────

test("findAuditJobs finds the jobs that run a given command", () => {
  const ci = [
    "jobs:",
    "  quality:",
    "    steps:",
    "      - run: pnpm test",
    "  prod-audit:",
    "    timeout-minutes: 10",
    "    steps:",
    "      - name: Audit",
    "        run: pnpm audit --audit-level=high --prod",
  ].join("\n");
  assert.deepEqual(findAuditJobs(ci, "pnpm audit --audit-level=high --prod"), [
    "prod-audit",
  ]);
  assert.deepEqual(findAuditJobs(ci, "pnpm audit --prod"), []);
});

test("CI runs the exact audit command the release gate runs (#993)", () => {
  // osv-scanner and pnpm audit read different acceptance files. An osv-only
  // acceptance of a high/critical production advisory is green in vuln-scan
  // and fails `pnpm release` — the #993 shape. With ignoreGhsas empty the
  // parity rule above has nothing to compare, so the release gate's command
  // itself has to run where a PR can see it. Read from release.mjs so the two
  // cannot drift into auditing different things.
  const release = readFileSync(join(REPO_ROOT, "scripts/release.mjs"), "utf8");
  const command = release.match(/execSync\("(pnpm audit [^"]+)"/)?.[1];
  assert.ok(command, "scripts/release.mjs no longer runs a pnpm audit command");
  const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.ok(
    findAuditJobs(ci, command).length > 0,
    `no ci.yml job runs \`${command}\` — the release gate's audit is checked nowhere before a tag is cut`,
  );
});

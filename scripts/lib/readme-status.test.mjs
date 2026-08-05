import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  SHIPPED_FEATURES,
  assertTermsAreSpecific,
  extractStatusItems,
  findFeaturesWithoutEvidence,
  findShippedPromises,
  findUnmentionedShippedFeatures,
  mentions,
} from "./readme-status.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const README = join(REPO_ROOT, "README.md");

// ── pure logic ────────────────────────────────────────────────────────────

test("mentions matches every word of a term, in any order", () => {
  assert.ok(
    mentions("Admin dashboard with usage analytics", "usage dashboard"),
  );
  assert.ok(mentions("Usage & Costs Dashboard", "usage dashboard"));
  assert.ok(!mentions("Admin dashboard", "usage dashboard"));
});

test("mentions does not fire on a substring", () => {
  // The bug a naive `includes` would ship: "groups" inside "subgroups".
  assert.ok(!mentions("Manage subgroups of a team", "groups"));
  assert.ok(mentions("Manage groups of a team", "groups"));
});

test("mentions keeps RBAC's 'permissions' away from agent permissions", () => {
  // The real "What's coming" line. It must stay a legal promise: granular RBAC
  // has not shipped, and a check that flagged it would be flagged off.
  assert.ok(
    !mentions("Full RBAC with team-scoped permissions", "agent permissions"),
  );
});

test("extractStatusItems reads the bullets under a heading and stops at the next one", () => {
  const readme = [
    "### What works today",
    "",
    "- **Setup wizard** — first run",
    "- **Telegram** — chat from your phone",
    "",
    "### What's coming",
    "",
    "- Plugin marketplace",
  ].join("\n");
  assert.deepEqual(extractStatusItems(readme, "What works today"), [
    "**Setup wizard** — first run",
    "**Telegram** — chat from your phone",
  ]);
  assert.deepEqual(extractStatusItems(readme, "What's coming"), [
    "Plugin marketplace",
  ]);
});

test("extractStatusItems stops at a deeper heading too", () => {
  const readme = [
    "### What works today",
    "",
    "- **Setup wizard** — first run",
    "",
    "#### Coming later this year",
    "",
    "- Plugin marketplace",
  ].join("\n");
  assert.deepEqual(extractStatusItems(readme, "What works today"), [
    "**Setup wizard** — first run",
  ]);
});

test("extractStatusItems throws instead of returning an empty list", () => {
  // An empty list makes every check below pass vacuously — the exact way a
  // coverage gate turns into decoration.
  assert.throws(
    () => extractStatusItems("# Pinchy\n\nNo status here.", "What works today"),
    /What works today/,
  );
  assert.throws(
    () =>
      extractStatusItems(
        "### What works today\n\nProse, no bullets.",
        "What works today",
      ),
    /no bullet items/,
  );
});

test("findUnmentionedShippedFeatures flags a shipped feature the list omits", () => {
  const features = [
    {
      name: "Odoo integration",
      terms: ["odoo"],
      evidence: "packages/plugins/pinchy-odoo",
    },
  ];
  const problems = findUnmentionedShippedFeatures(
    ["- **Setup wizard**"],
    features,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Odoo integration/);
  assert.deepEqual(
    findUnmentionedShippedFeatures(["**Odoo** — scoped ERP access"], features),
    [],
  );
});

test("findUnmentionedShippedFeatures does not accept a term split across bullets", () => {
  // The looseness a joined match would ship: "web" in one bullet and "search"
  // in another satisfy "web search" while no bullet describes the feature.
  const features = [
    {
      name: "Web search",
      terms: ["web search"],
      evidence: "packages/plugins/pinchy-web",
    },
  ];
  assert.equal(
    findUnmentionedShippedFeatures(
      ["**Web UI** — chat in the browser", "**Search** — find a conversation"],
      features,
    ).length,
    1,
  );
  assert.deepEqual(
    findUnmentionedShippedFeatures(["**Web search** — via Brave"], features),
    [],
  );
});

test("findShippedPromises flags a promise of something that already shipped", () => {
  const features = [
    {
      name: "Usage & costs dashboard",
      terms: ["usage dashboard", "usage analytics"],
      evidence: "packages/web/src/app/api/usage",
    },
  ];
  const problems = findShippedPromises(
    [
      "Admin dashboard with usage analytics",
      "Plugin marketplace for agent tools",
    ],
    features,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /already shipped/);
  // The roadmap item that names nothing in the tree is left alone.
  assert.match(problems[0], /usage analytics/);
});

test("findFeaturesWithoutEvidence flags a verdict that outlived its evidence", () => {
  const features = [
    { name: "Gone", terms: ["gone"], evidence: "packages/plugins/pinchy-gone" },
  ];
  assert.equal(findFeaturesWithoutEvidence(features, () => false).length, 1);
  assert.deepEqual(
    findFeaturesWithoutEvidence(features, () => true),
    [],
  );
});

test("assertTermsAreSpecific rejects a one-word term that means too much", () => {
  assert.equal(
    assertTermsAreSpecific([{ name: "X", terms: ["dashboard"], evidence: "p" }])
      .length,
    1,
  );
  assert.deepEqual(
    assertTermsAreSpecific([
      { name: "X", terms: ["usage dashboard"], evidence: "p" },
    ]),
    [],
  );
});

// ── the repo itself ───────────────────────────────────────────────────────

test("every SHIPPED_FEATURES entry still points at code that exists", () => {
  assert.ok(
    SHIPPED_FEATURES.length > 5,
    `expected the full feature set, found ${SHIPPED_FEATURES.length}`,
  );
  assert.deepEqual(
    findFeaturesWithoutEvidence(SHIPPED_FEATURES, (p) =>
      existsSync(join(REPO_ROOT, p)),
    ),
    [],
  );
});

test("every SHIPPED_FEATURES term is specific enough to mean one feature", () => {
  assert.deepEqual(assertTermsAreSpecific(SHIPPED_FEATURES), []);
});

test("the README's 'What works today' names every shipped feature", () => {
  const items = extractStatusItems(
    readFileSync(README, "utf8"),
    "What works today",
  );
  assert.deepEqual(findUnmentionedShippedFeatures(items, SHIPPED_FEATURES), []);
});

test("the README's 'What's coming' promises nothing that already shipped", () => {
  const items = extractStatusItems(
    readFileSync(README, "utf8"),
    "What's coming",
  );
  assert.deepEqual(findShippedPromises(items, SHIPPED_FEATURES), []);
});

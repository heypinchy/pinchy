import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  NAV_EXEMPT_PAGES,
  extractAgentSettingsTabLabels,
  extractForwardClaims,
  extractSettingsTabLabels,
  findResolvedForwardClaims,
  findOrphanPages,
  findUnknownSettingsPaths,
  findUntrackedForwardClaims,
} from "./docs-consistency.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = join(REPO_ROOT, "docs/src/content/docs");
const SETTINGS_PAGE = join(
  REPO_ROOT,
  "packages/web/src/components/settings-page-content.tsx",
);
const TAB_PARAM = join(REPO_ROOT, "packages/web/src/hooks/use-tab-param.ts");

// ── pure logic ────────────────────────────────────────────────────────────

test("findOrphanPages flags a page with no sidebar entry", () => {
  const problems = findOrphanPages(
    ["security/secrets"],
    'slug: "guides/hardening"',
    {},
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /security\/secrets/);
});

test("findOrphanPages accepts a page the sidebar names, and an exempt one", () => {
  assert.deepEqual(
    findOrphanPages(["guides/hardening"], 'slug: "guides/hardening"', {}),
    [],
  );
  assert.deepEqual(
    findOrphanPages(["index"], "", { index: "the landing page" }),
    [],
  );
});

test("extractSettingsTabLabels reads the labels the UI renders", () => {
  const labels = extractSettingsTabLabels(
    'const TAB_LABELS: Record<SettingsTab, string> = {\n  provider: "AI Provider",\n  users: "Users",\n};',
  );
  assert.deepEqual(labels, ["AI Provider", "Users"]);
});

test("extractAgentSettingsTabLabels Title-Cases the agent tab ids", () => {
  assert.deepEqual(
    extractAgentSettingsTabLabels(
      'export const AGENT_SETTINGS_TABS = [\n  "general",\n  "automations",\n] as const;',
    ),
    ["General", "Automations"],
  );
});

test("extractSettingsTabLabels fails loudly when the map moves", () => {
  assert.throws(
    () => extractSettingsTabLabels("const other = {};"),
    /TAB_LABELS/,
  );
});

test("findUnknownSettingsPaths flags a renamed tab and accepts a real one", () => {
  const labels = ["AI Provider", "Security"];
  assert.deepEqual(
    findUnknownSettingsPaths(
      [{ path: "a.mdx", source: "open **Settings → Security**" }],
      labels,
    ),
    [],
  );
  const problems = findUnknownSettingsPaths(
    [{ path: "a.mdx", source: "open **Settings → Providers** and save" }],
    labels,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Settings → Providers/);
});

test("findUnknownSettingsPaths ignores another product's settings menu", () => {
  assert.deepEqual(
    findUnknownSettingsPaths(
      [
        {
          path: "a.mdx",
          source: "Enable FileVault in System Settings → Privacy & Security.",
        },
      ],
      ["Security"],
    ),
    [],
  );
});

test("findUnknownSettingsPaths leaves the upgrade guide's historical prose alone", () => {
  assert.deepEqual(
    findUnknownSettingsPaths(
      [
        {
          path: "docs/guides/upgrading.mdx",
          source: "go to **Settings → Providers**",
        },
      ],
      ["AI Provider"],
    ),
    [],
  );
});

test("findUntrackedForwardClaims wants an issue behind a promise", () => {
  const problems = findUntrackedForwardClaims([
    { path: "a.mdx", source: "A scheduled sweep is planned for later." },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a\.mdx:1/);
});

test("findUntrackedForwardClaims accepts a promise with a nearby issue", () => {
  assert.deepEqual(
    findUntrackedForwardClaims([
      {
        path: "a.mdx",
        source: "A scheduled sweep is planned.\n\nTracked in #714.",
      },
    ]),
    [],
  );
});

test("findUntrackedForwardClaims does not flag ordinary prose about the present", () => {
  // The phrases that made a naive version of this check unusable: an invite
  // "not yet claimed", an upload "not yet part of a conversation".
  assert.deepEqual(
    findUntrackedForwardClaims([
      {
        path: "a.mdx",
        source:
          "Pending (invite not yet claimed)\nThe file is not yet part of any conversation.",
      },
    ]),
    [],
  );
});

test("findUntrackedForwardClaims reads 'is tracked in' as the promise it is", () => {
  // The shape that slipped past the weekly cron: the KB guide said "a
  // scheduled sweep is tracked in [#714]" while the two claims either side of
  // it were reported. It asserts the work has a live home, which is exactly
  // what the other phrases promise.
  const problems = findUntrackedForwardClaims([
    {
      path: "a.mdx",
      source: "A scheduled sweep is tracked in a backlog item.",
    },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a\.mdx:1/);
});

test("findUntrackedForwardClaims leaves 'tracked' used about the present alone", () => {
  // Measured across the docs tree before the phrase was added: this is the
  // sentence that decided it had to be `is tracked in` and not `tracked`.
  assert.deepEqual(
    findUntrackedForwardClaims([
      {
        path: "a.mdx",
        source: "Changes across all tabs are tracked independently.",
      },
    ]),
    [],
  );
});

test("extractForwardClaims reports the issues a promise cites", () => {
  const claims = extractForwardClaims([
    {
      path: "a.mdx",
      source:
        "OCR is on the roadmap ([#941](https://github.com/heypinchy/pinchy/issues/941)).",
    },
  ]);
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].issues, [941]);
  assert.equal(claims[0].line, 1);
});

test("extractForwardClaims skips a promise with no issue — the PR gate owns that", () => {
  assert.deepEqual(
    extractForwardClaims([{ path: "a.mdx", source: "is planned." }]),
    [],
  );
});

test("findResolvedForwardClaims flags a promise whose issue has closed", () => {
  const claims = extractForwardClaims([
    { path: "a.mdx", source: "A progress UI is planned (#714)." },
  ]);
  assert.equal(findResolvedForwardClaims(claims, { 714: "closed" }).length, 1);
  assert.equal(findResolvedForwardClaims(claims, { 714: "open" }).length, 0);
});

test("findResolvedForwardClaims keeps a multi-issue promise alive while one issue is open", () => {
  // "custom roles (#527) and SSO (#526) are on the roadmap" is still true when
  // only one of them has shipped.
  const claims = extractForwardClaims([
    {
      path: "a.mdx",
      source: "Custom roles (#527) and SSO (#526) are planned.",
    },
  ]);
  assert.equal(
    findResolvedForwardClaims(claims, { 527: "closed", 526: "open" }).length,
    0,
  );
  assert.equal(
    findResolvedForwardClaims(claims, { 527: "closed", 526: "closed" }).length,
    1,
  );
});

test("findResolvedForwardClaims treats an unknown issue as unknown, not as closed", () => {
  // A GitHub call that failed must not turn into a verdict in either
  // direction; silence is silence.
  const claims = extractForwardClaims([
    { path: "a.mdx", source: "Something is planned (#999)." },
  ]);
  assert.deepEqual(findResolvedForwardClaims(claims, {}), []);
});

// ── the repo itself ───────────────────────────────────────────────────────

/** @returns {Array<{path: string, source: string}>} every docs page */
function readDocPages(dir = DOCS) {
  /** @type {Array<{path: string, source: string}>} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...readDocPages(abs));
    else if (entry.endsWith(".mdx") || entry.endsWith(".md")) {
      out.push({
        path: relative(REPO_ROOT, abs).split("\\").join("/"),
        source: readFileSync(abs, "utf8"),
      });
    }
  }
  return out;
}

const pageId = (p) =>
  relative(DOCS, join(REPO_ROOT, p))
    .replace(/\.mdx?$/, "")
    .split("\\")
    .join("/");

test("every docs page is reachable from the sidebar", () => {
  const pages = readDocPages().map((d) => pageId(d.path));
  assert.ok(
    pages.length > 50,
    `expected the full page set, found ${pages.length}`,
  );
  assert.deepEqual(
    findOrphanPages(
      pages,
      readFileSync(join(REPO_ROOT, "docs/astro.config.mjs"), "utf8"),
    ),
    [],
  );
});

test("every documented settings path names a real tab", () => {
  // Both tab sets: the docs write "Settings → Users" (org) and
  // "Agent Settings → General" (per agent) with the same arrow.
  const labels = [
    ...extractSettingsTabLabels(readFileSync(SETTINGS_PAGE, "utf8")),
    ...extractAgentSettingsTabLabels(readFileSync(TAB_PARAM, "utf8")),
  ];
  assert.ok(
    labels.length > 15,
    `expected both tab sets, found ${labels.length}`,
  );
  assert.deepEqual(findUnknownSettingsPaths(readDocPages(), labels), []);
});

test("every forward-looking promise in the docs names a tracking issue", () => {
  assert.deepEqual(findUntrackedForwardClaims(readDocPages()), []);
});

test("every nav exemption carries a reason and still exists", () => {
  const pages = new Set(readDocPages().map((d) => pageId(d.path)));
  for (const [key, reason] of Object.entries(NAV_EXEMPT_PAGES)) {
    assert.ok(
      pages.has(key),
      `NAV_EXEMPT_PAGES lists "${key}", which is no longer a page`,
    );
    assert.ok(
      reason.trim().length > 20,
      `exemption "${key}" needs a real reason`,
    );
  }
});

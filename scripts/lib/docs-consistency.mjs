/**
 * Three docs checks that need no build, no network, and no judgement (#1002).
 *
 * Each one closes a hole the 2026-07-30 docs audit walked straight into:
 *
 *   1. `security/secrets.md` had been reachable only from inline links for
 *      months — no sidebar entry, so the page existed and nobody could find it.
 *   2. Four pages still said "Settings → Providers" after the tab was renamed
 *      to "AI Provider". A docs commit had claimed to align them all and
 *      missed these; nothing noticed, because prose has no compiler.
 *   3. Two pages promised a feature "for a later phase" that had already
 *      shipped — one of them contradicted by its own page, 120 lines up.
 *
 * (3) is the interesting one. A script cannot know whether a sentence about the
 * future is still true, so it does not try. It requires the sentence to name a
 * tracking issue, which turns an un-checkable claim into a checkable one: the
 * weekly freshness job (and the release preflight) then asks GitHub whether
 * that issue is closed, and a closed issue behind a "planned" sentence is a
 * doc that describes a world that no longer exists. Same contract as
 * AGENTS.md's "No Untracked Test Skips" — the issue is what makes the promise
 * auditable.
 *
 * The phrase list is deliberately narrow. "not yet claimed" (an invite) and
 * "not yet part of a conversation" (a staged upload) are ordinary prose, not
 * commitments; a guard that flags them gets switched off within a week.
 */

/** Pages that legitimately have no sidebar entry, with the reason. */
export const NAV_EXEMPT_PAGES = {
  index: "the landing page — it IS the docs root, not an entry inside it",
};

/**
 * Forward-looking commitments. Matched case-insensitively against the prose.
 * Add a phrase only if it promises future behaviour; anything that merely
 * describes a current state belongs nowhere near this list.
 */
export const FORWARD_LOOKING_PHRASES = [
  "not yet implemented",
  "not yet supported",
  "on the roadmap",
  "coming soon",
  "in a future release",
  "in a later phase",
  "for a later phase",
  "are planned",
  "is planned",
  "will ship",
];

/** How far from the phrase an issue reference still counts as attached. */
const ISSUE_PROXIMITY_LINES = 3;

const ISSUE_REFERENCE = /#\d+|github\.com\/[^/]+\/[^/]+\/issues\/\d+/;

/**
 * @param {string[]} pages page ids relative to the content root, without
 *   extension (e.g. "guides/hardening", "index")
 * @param {string} sidebarSource contents of docs/astro.config.mjs
 * @param {Record<string, string>} [exempt]
 * @returns {string[]} problems (empty = ok)
 */
export function findOrphanPages(
  pages,
  sidebarSource,
  exempt = NAV_EXEMPT_PAGES,
) {
  const slugs = new Set(
    [...sidebarSource.matchAll(/\bslug:\s*["']([^"']*)["']/g)].map((m) => m[1]),
  );
  return pages
    .filter((p) => !(p in exempt))
    .filter((p) => !slugs.has(p) && !slugs.has(`/${p}`))
    .map(
      (p) =>
        `docs page "${p}" has no sidebar entry — readers can only reach it from an ` +
        `inline link (add it to astro.config.mjs, or to NAV_EXEMPT_PAGES with a reason)`,
    );
}

/**
 * Checks that every `Settings → X` in the docs names a tab that exists.
 *
 * @param {string} settingsPageSource contents of components/settings-page-content.tsx
 * @returns {string[]} the tab labels the UI actually renders
 */
export function extractSettingsTabLabels(settingsPageSource) {
  const block = /const TAB_LABELS[^=]*=\s*\{([\s\S]*?)\}/.exec(
    settingsPageSource,
  );
  if (!block)
    throw new Error("settings-page-content.tsx: could not find TAB_LABELS");
  return [...block[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The agent's own settings tabs, which the docs also write as `Settings → X`
 * ("Agent Settings → General"). Their ids are single words that Title-Case
 * exactly onto the rendered label, so the id list is a faithful source — no
 * second hand-maintained table.
 *
 * @param {string} tabParamSource contents of hooks/use-tab-param.ts
 * @returns {string[]}
 */
export function extractAgentSettingsTabLabels(tabParamSource) {
  const block = /export const AGENT_SETTINGS_TABS\s*=\s*\[([\s\S]*?)\]/.exec(
    tabParamSource,
  );
  if (!block)
    throw new Error("use-tab-param.ts: could not find AGENT_SETTINGS_TABS");
  return [...block[1].matchAll(/"([a-z]+)"/g)].map(
    (m) => m[1][0].toUpperCase() + m[1].slice(1),
  );
}

/**
 * @param {Array<{path: string, source: string}>} docs
 * @param {string[]} tabLabels
 * @returns {string[]} problems (empty = ok)
 */
export function findUnknownSettingsPaths(docs, tabLabels) {
  const known = new Set(tabLabels);
  const problems = [];
  for (const { path, source } of docs) {
    // The upgrade guide is a historical record: its older sections describe the
    // UI as it was at the time, and rewriting them would falsify the record.
    if (path.endsWith("guides/upgrading.mdx")) continue;
    // A tab label is Title Case, so the match stops at the first lowercase
    // word: "go to Settings → Telegram first" names the Telegram tab, not a
    // tab called "Telegram first".
    //
    // `(?<!System )` keeps another product's settings out of ours — the
    // hardening guide sends macOS users to "System Settings → Privacy &
    // Security", which is Apple's menu and none of this check's business.
    for (const [, label] of source.matchAll(
      /(?<!System )Settings\s+→\s+([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*)/g,
    )) {
      const trimmed = label.trim();
      if (trimmed && !known.has(trimmed)) {
        problems.push(
          `${path}: "Settings → ${trimmed}" names no settings tab ` +
            `(the tabs are: ${[...known].join(", ")})`,
        );
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * @param {Array<{path: string, source: string}>} docs
 * @param {string[]} [phrases]
 * @returns {string[]} problems (empty = ok)
 */
export function findUntrackedForwardClaims(
  docs,
  phrases = FORWARD_LOOKING_PHRASES,
) {
  const problems = [];
  for (const { path, source } of docs) {
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      const hit = phrases.find((p) => line.toLowerCase().includes(p));
      if (!hit) return;
      const window = lines
        .slice(
          Math.max(0, i - ISSUE_PROXIMITY_LINES),
          i + ISSUE_PROXIMITY_LINES + 1,
        )
        .join("\n");
      if (!ISSUE_REFERENCE.test(window)) {
        problems.push(
          `${path}:${i + 1}: "${hit}" promises future behaviour with no tracking issue nearby. ` +
            `Cite the issue (#NNN) so a closed issue can flag the sentence when it stops being true.`,
        );
      }
    });
  }
  return problems;
}

/**
 * The README's status section, read against the code (#1082).
 *
 * `docs-consistency` and `docs-coverage` both stop at `docs/`. The README is
 * the page most people read first — it is the repository's landing page and
 * what GitHub renders on the project card — and nothing had ever checked it.
 * The 2026-08-04 audit found it stale in *both* directions at once:
 *
 *   - "What works today" omitted Telegram, Odoo, web search, email
 *     automations, the usage dashboard, groups and the domain lock — seven
 *     shipped features, three of them headline ones.
 *   - "What's coming" still promised email automations and usage analytics,
 *     both of which had shipped. A reader comparing the two lists would
 *     conclude the opposite of the truth about the same feature.
 *
 * That second direction is the one worth naming: a stale promise is not a
 * missing sentence, it is a *false* one, and it reads as authoritative because
 * it sits under a heading that claims to describe the future.
 *
 * The check is deliberately evidence-based rather than a hand-kept list of
 * feature names. Each entry pairs the words the README would use with a path
 * whose existence proves the feature shipped, and `findFeaturesWithoutEvidence`
 * fails when that path goes away — so a verdict here cannot outlive the code it
 * describes, the same contract `KNOWN_PRE_GUARD_DRIFT` and the triage ledger
 * carry elsewhere in this repo.
 *
 * What it deliberately does NOT do is judge the roadmap. "Plugin marketplace"
 * names nothing in the tree, so it stays a promise and this check has no
 * opinion on it. It only ever says: this shipped, so stop calling it future
 * work — and: this shipped, so say so.
 *
 * One sharp edge, met while writing this: `findShippedPromises` reads a name,
 * not a sentence, so "More channels beyond web and Telegram" is flagged even
 * though it promises the opposite of shipping Telegram. That is a false
 * positive, and the fix is the prose, not an exception for "beyond" — a
 * roadmap line that argues from the name of a shipped feature is exactly the
 * ambiguity this section had. Say what is coming without naming what is here.
 */

/**
 * Features whose presence in the tree is a fact, paired with the words the
 * README uses for them.
 *
 * `terms` are matched word-wise and unordered: every word of a term must appear
 * in the text, so "usage dashboard" matches "Admin dashboard with usage
 * analytics" (the exact stale promise this check was written for) while
 * "agent permissions" does NOT match "Full RBAC with team-scoped permissions".
 * A term therefore needs at least two words, or one word specific enough to
 * mean only this feature — `assertTermsAreSpecific` holds that line.
 *
 * `evidence` is a repo-relative path. Prefer the route or plugin directory that
 * *is* the feature over a file that merely mentions it.
 */
export const SHIPPED_FEATURES = [
  {
    name: "Telegram channels",
    terms: ["telegram"],
    evidence: "packages/web/src/app/api/settings/telegram",
  },
  {
    name: "Odoo integration",
    terms: ["odoo"],
    evidence: "packages/plugins/pinchy-odoo",
  },
  {
    name: "Web search",
    terms: ["web search"],
    evidence: "packages/plugins/pinchy-web",
  },
  {
    name: "Email integration",
    terms: ["email integration", "connect email", "read email", "send email"],
    evidence: "packages/plugins/pinchy-email",
  },
  {
    name: "Email automations",
    terms: ["email automations", "email workflows", "inbox automations"],
    evidence: "packages/web/src/app/api/automations",
  },
  {
    name: "Usage & costs dashboard",
    terms: ["usage dashboard", "usage analytics", "usage costs", "token usage"],
    evidence: "packages/web/src/app/api/usage",
  },
  {
    name: "Groups",
    terms: ["groups"],
    evidence: "packages/web/src/app/api/groups",
  },
  {
    name: "Domain lock",
    terms: ["domain lock"],
    evidence: "packages/web/src/app/api/settings/domain",
  },
  {
    name: "Knowledge base agents",
    terms: ["knowledge base"],
    evidence: "packages/plugins/pinchy-knowledge",
  },
];

/** Words a one-word term must not be, because they mean too many things. */
const TOO_GENERIC = new Set([
  "agent",
  "agents",
  "api",
  "chat",
  "dashboard",
  "email",
  "permissions",
  "search",
  "settings",
  "usage",
  "users",
  "workflows",
]);

const words = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Does `text` mention `term`? Every word of the term must appear in the text,
 * in any order.
 *
 * Word-wise rather than `includes` for the reason AGENTS.md gives about the
 * docs-coverage guard: a substring match makes "usage" match "usages" and
 * "groups" match "subgroups", and a check that accepts a coincidence is a check
 * that passes when it should not.
 *
 * @param {string} text
 * @param {string} term
 */
export function mentions(text, term) {
  const have = new Set(words(text));
  const want = words(term);
  return want.length > 0 && want.every((w) => have.has(w));
}

/**
 * The bullet items under a `### <heading>` in the README.
 *
 * Throws rather than returning `[]` when the heading is missing or carries no
 * bullets. An empty list would make every check below vacuously pass, which is
 * exactly how a coverage gate becomes decoration — the same failure the
 * docs-coverage extractors throw to avoid.
 *
 * @param {string} readme
 * @param {string} heading e.g. "What works today"
 * @returns {string[]} one entry per bullet, markdown intact
 */
export function extractStatusItems(readme, heading) {
  const lines = readme.split("\n");
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `### ${heading}`.toLowerCase(),
  );
  if (start === -1) {
    throw new Error(
      `README.md: no "### ${heading}" heading. The status section is what ` +
        `readme-status.mjs checks; if it moved, move this check with it.`,
    );
  }
  const items = [];
  for (const line of lines.slice(start + 1)) {
    // Any heading ends the section, including a deeper one: `#### Something`
    // introduces its own bullets, and counting those as this section's would
    // let a subsection satisfy a check about the section above it.
    if (/^#{1,6} /.test(line)) break;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) items.push(bullet[1].trim());
  }
  if (items.length === 0) {
    throw new Error(`README.md: "### ${heading}" has no bullet items`);
  }
  return items;
}

/**
 * Shipped features the "What works today" list never mentions.
 *
 * @param {string[]} items
 * @param {typeof SHIPPED_FEATURES} features
 * @returns {string[]} problems (empty = ok)
 */
export function findUnmentionedShippedFeatures(items, features) {
  // Per bullet, never across the joined list. A term's words scattered over two
  // unrelated bullets — "web" in one, "search" in another — would satisfy a
  // joined match while nothing in the list describes the feature, which is the
  // same accept-a-coincidence failure `mentions` refuses at the word level.
  return features
    .filter((f) => !f.terms.some((t) => items.some((i) => mentions(i, t))))
    .map(
      (f) =>
        `README.md "What works today" never mentions ${f.name}, which shipped ` +
        `(${f.evidence} is in the tree). Add it, or drop the SHIPPED_FEATURES entry.`,
    );
}

/**
 * "What's coming" entries that name something already shipped.
 *
 * This is the direction that produces a false sentence rather than a missing
 * one, so the message quotes the bullet back — the point is not that a name
 * appears somewhere, it is that *this line* promises a thing that exists.
 *
 * @param {string[]} items
 * @param {typeof SHIPPED_FEATURES} features
 * @returns {string[]} problems (empty = ok)
 */
export function findShippedPromises(items, features) {
  const problems = [];
  for (const item of items) {
    for (const f of features) {
      if (f.terms.some((t) => mentions(item, t))) {
        problems.push(
          `README.md "What's coming" promises ${f.name}, which already shipped ` +
            `(${f.evidence}):\n    > ${item}`,
        );
      }
    }
  }
  return problems;
}

/**
 * Entries whose evidence path is gone — the verdict outliving its evidence.
 *
 * @param {typeof SHIPPED_FEATURES} features
 * @param {(path: string) => boolean} exists
 * @returns {string[]} problems (empty = ok)
 */
export function findFeaturesWithoutEvidence(features, exists) {
  return features
    .filter((f) => !exists(f.evidence))
    .map(
      (f) =>
        `SHIPPED_FEATURES entry "${f.name}" points at ${f.evidence}, which no ` +
        `longer exists. Repoint it at what proves the feature ships today, or ` +
        `remove the entry (and say so in the README).`,
    );
}

/**
 * Terms too generic to mean one feature.
 *
 * A single word like "dashboard" would match half the roadmap and turn this
 * check into noise; the fix is a more specific term, never a longer ignore
 * list.
 *
 * @param {typeof SHIPPED_FEATURES} features
 * @returns {string[]} problems (empty = ok)
 */
export function assertTermsAreSpecific(features) {
  const problems = [];
  for (const f of features) {
    if (f.terms.length === 0) {
      problems.push(`SHIPPED_FEATURES entry "${f.name}" has no terms`);
    }
    for (const term of f.terms) {
      const w = words(term);
      if (w.length === 1 && TOO_GENERIC.has(w[0])) {
        problems.push(
          `SHIPPED_FEATURES entry "${f.name}" uses the one-word term "${term}", ` +
            `which is too generic to mean this feature alone. Use two words.`,
        );
      }
    }
  }
  return problems;
}

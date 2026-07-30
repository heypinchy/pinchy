/**
 * Pure logic for the docs-required guard (see scripts/check-docs-required.mjs
 * for the CI wrapper and AGENTS.md § "A User-Visible Change Needs A Docs
 * Change").
 *
 * AGENTS.md has said "when behavior changes, update docs in the same PR" for
 * as long as it has existed. Nothing enforced it, and the 2026-07-30 audit
 * measured the result: Automations, OpenAI-compatible providers and IMAP all
 * shipped in the v0.9.0 cycle with no entry in the API reference, and
 * `knowledge_search` — the release's headline capability — reached users
 * without appearing on the permissions page at all.
 *
 * The `docs-coverage` guard now catches those three lists after the fact, at
 * the moment someone writes the code. This one catches the class those lists
 * cannot see: a changed *behaviour* whose prose is now wrong, which no
 * identifier-matching check can detect. It cannot verify that the docs change
 * is the RIGHT one — only that the author was made to think about it. That is
 * the same bargain Kubernetes makes with its release-note gate, and it is
 * worth making, because "I forgot" is the failure mode, not "I decided not to".
 *
 * Deliberately NOT every source file. A guard that fires on a refactor is a
 * guard that gets an escape hatch typed into it reflexively, and then it guards
 * nothing. The surfaces below are the ones where a change is almost always
 * visible to a reader of the docs.
 */

/**
 * Files whose change implies a user-visible surface moved. Each entry carries
 * the doc a reader would go to, so the failure message can name it.
 *
 * @type {Array<{re: RegExp, what: string, docs: string}>}
 */
export const USER_VISIBLE_SURFACES = [
  {
    re: /^packages\/web\/src\/app\/api\/.*\/route\.ts$/,
    what: "an API route",
    docs: "docs/src/content/docs/reference/api.mdx",
  },
  {
    re: /^packages\/web\/src\/lib\/tool-registry\.ts$/,
    what: "the grantable-tool registry",
    docs: "docs/src/content/docs/concepts/agent-permissions.mdx",
  },
  {
    re: /^packages\/web\/src\/lib\/agent-templates\/data\/.*\.ts$/,
    what: "an agent template",
    docs: "docs/src/content/docs/concepts/agent-permissions.mdx",
  },
  {
    re: /^packages\/web\/src\/lib\/audit\.ts$/,
    what: "the audit event catalogue",
    docs: "docs/src/content/docs/concepts/audit-trail.mdx",
  },
  {
    re: /^packages\/web\/src\/components\/settings-page-content\.tsx$/,
    what: "the settings navigation",
    docs: "the guides that send readers to a settings tab",
  },
  {
    re: /^packages\/plugins\/pinchy-[^/]+\/openclaw\.plugin\.json$/,
    what: "a plugin's declared tools",
    docs: "docs/src/content/docs/concepts/agent-permissions.mdx",
  },
];

const DOCS_PATH_RE = /^docs\//;

// Anchored at line start and global, for the same reasons the
// Allow-test-deletion trailer is (see check-test-deletions.mjs): `git log`
// concatenates every commit message, so an earlier commit's prose mention must
// not shadow the real trailer in a later one.
const TRAILER_RE = /^[ \t]*Docs-not-needed:[ \t]*(.+)$/gim;

/**
 * The shortest override reason we accept. "no" and "n/a" are not reasons; the
 * point of the escape hatch is that someone had to state what makes this
 * change invisible to a reader.
 */
export const MIN_REASON_LENGTH = 12;

/**
 * @param {string[]} changedPaths repo-relative, forward slashes
 * @returns {{ surfaces: Array<{path: string, what: string, docs: string}>, docsTouched: boolean }}
 */
export function analyzeChangedPaths(changedPaths) {
  const surfaces = [];
  let docsTouched = false;
  for (const path of changedPaths) {
    if (DOCS_PATH_RE.test(path)) docsTouched = true;
    const hit = USER_VISIBLE_SURFACES.find((s) => s.re.test(path));
    if (hit) surfaces.push({ path, what: hit.what, docs: hit.docs });
  }
  return { surfaces, docsTouched };
}

/**
 * Whether skipping the docs change is explicitly authorized.
 *
 * The bar is a written reason, not an issue number — and that difference from
 * the skip/deletion guards is deliberate. A skip DEFERS work, so it needs
 * somewhere for the work to live. "No docs needed" ASSERTS a fact ("this
 * endpoint is gateway-only", "this template is not offered in the UI"), and
 * the useful artefact is the assertion itself, in the history, next to the
 * change it describes. An issue number here would be a placeholder for an
 * issue nobody ever opens.
 *
 * @param {{ envValue?: string, messages?: string[] }} input
 * @returns {{ allowed: boolean, reason: string }}
 */
export function parseDocsOverride({ envValue, messages = [] } = {}) {
  const env = (envValue ?? "").trim().toLowerCase();
  if (env === "true" || env === "1" || env === "yes") {
    return { allowed: true, reason: "docs-not-needed label" };
  }
  for (const message of messages) {
    for (const match of message.matchAll(TRAILER_RE)) {
      const reason = match[1].trim();
      if (reason.length >= MIN_REASON_LENGTH) {
        return { allowed: true, reason: `Docs-not-needed trailer (${reason})` };
      }
    }
  }
  return { allowed: false, reason: "" };
}

/**
 * @param {{ surfaces: Array<{path: string, what: string, docs: string}>, docsTouched: boolean }} analysis
 * @returns {string} human-facing failure text, or "" when the PR is fine
 */
export function formatFailure({ surfaces, docsTouched }) {
  if (docsTouched || surfaces.length === 0) return "";
  const byDoc = new Map();
  for (const s of surfaces) {
    if (!byDoc.has(s.docs)) byDoc.set(s.docs, []);
    byDoc.get(s.docs).push(`${s.path} (${s.what})`);
  }
  const lines = [
    "This PR changes a user-visible surface but no file under docs/.",
    "",
  ];
  for (const [docs, paths] of byDoc) {
    lines.push(`  → ${docs}`);
    for (const p of paths) lines.push(`      ${p}`);
  }
  lines.push(
    "",
    "Update the docs in the same PR, or say why they don't move:",
    "  - apply the `docs-not-needed` label, or",
    "  - add a commit trailer: Docs-not-needed: <what makes this invisible to a reader>",
  );
  return lines.join("\n");
}

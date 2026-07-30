/**
 * Decides whether a push needs the `pre-push` production build.
 *
 * WHAT THE BUILD PROTECTS — do not weaken this without reading it. `next build`
 * is the only check in the local loop that sees the Next.js **client/server
 * bundling boundary**. A shared lib module imported by a Client Component must
 * not transitively pull in a server-only dependency (`@/db`, `postgres`,
 * `@/lib/settings`); when it does, the DB driver lands in the client bundle and
 * the build fails with "module not found". `tsc --noEmit` checks types, not
 * bundling, and the vitest suite resolves `postgres` in Node without complaint —
 * both pass green while the app does not build. That has shipped here before.
 *
 * So the build is NOT moved to CI and NOT made optional. It is moved off the
 * paths that provably cannot produce that failure. `next build` type-checks and
 * bundles exactly what `packages/web/tsconfig.json` includes: `**\/*.ts(x)` under
 * `packages/web`, minus that file's `exclude` list. A change confined to docs,
 * plugins, CI config, root scripts or an excluded web test file cannot alter one
 * byte of the build's input, so building on it buys no guarantee — only the
 * single largest per-iteration cost in the whole agent loop.
 *
 * The pairing between this module's exclusions and tsconfig's `exclude` array is
 * pinned by prepush-build-gate.test.mjs, so shrinking that array fails the tests
 * instead of silently turning this gate into a lie.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";

/** Repo-root directories whose contents never reach `next build`. */
const IRRELEVANT_PREFIXES = [
  // Prose, and Astro Starlight's own standalone package.
  "docs/",
  // Workflow definitions, issue templates, actions.
  ".github/",
  // Git hooks themselves.
  ".husky/",
  // Root tooling: the CI path filter, drift guards, release scripts. Note this
  // is the ROOT scripts/ only — packages/web/scripts/*.ts IS inside the web
  // tsconfig include and does affect the build.
  "scripts/",
  // Mock servers and OpenClaw startup support used by the docker test stacks.
  "config/",
  // Knowledge-base fixtures mounted into Docker.
  "sample-data/",
  "screenshots/",
  // 1-Click deploy templates.
  "marketplace/",
  // OpenClaw plugins run under tsx in their own container with their own
  // tsconfigs; `pnpm typecheck:plugins` is their gate, not `next build`. Their
  // MANIFESTS are the exception — see BUILD_RELEVANT_OUTSIDE_WEB below.
  "packages/plugins/",
  // Agent/editor local configuration.
  ".claude/",
  // Static assets: a missing file here does not fail the build.
  "packages/web/public/",
  // Drizzle migrations are .sql plus meta/*.json — neither is matched by the
  // web tsconfig's include globs.
  "packages/web/drizzle/",
];

/** Repo-root files that never reach `next build`. */
const IRRELEVANT_FILES = new Set([
  // Excluded by packages/web/tsconfig.json (pinned by the test).
  "packages/web/vitest.config.ts",
  "packages/web/src/test-setup.ts",
  ".gitignore",
  ".prettierignore",
  ".dockerignore",
  "LICENSE",
]);

/**
 * Files OUTSIDE packages/web that `next build` nevertheless compiles, because a
 * web source imports them with a relative path that climbs out of the package.
 *
 * tsconfig's include globs decide which files are type-checked; they do not
 * decide where those files may reach. `src/lib/openclaw-config/plugin-manifest-
 * loader.ts` statically imports all nine `packages/plugins/pinchy-*
 * /openclaw.plugin.json` manifests (`resolveJsonModule`), so a manifest that is
 * malformed — or that loses a field the loader reads — really does fail
 * `next build`. "packages/plugins/ never reaches the build" was true of the
 * plugin source and false of these, and a manifest-only push skipped anyway.
 *
 * This is a carve-out from IRRELEVANT_PREFIXES, checked before it. Do not extend
 * it by hand: `escapingImportTargets` + the drift guard in
 * prepush-build-gate.test.mjs derive the escapes from the source, so a new
 * cross-package import fails the tests until it is classified here.
 */
const BUILD_RELEVANT_OUTSIDE_WEB = [
  /^packages\/plugins\/[^/]+\/openclaw\.plugin\.json$/,
];

/**
 * @param {string} path repo-relative path of a changed file
 * @returns {boolean} true when the path cannot change `next build`'s outcome
 */
export function isBuildIrrelevant(path) {
  const p = path.trim();
  if (p.length === 0) return false;

  // Before every rule below, including the .md shortcut: a file the build
  // genuinely imports is build-relevant whatever else it looks like.
  if (BUILD_RELEVANT_OUTSIDE_WEB.some((re) => re.test(p))) return false;

  // Prose anywhere, including docs/, PERSONALITY.md and every package README.
  if (p.endsWith(".md") || p.endsWith(".mdx")) return true;

  // Compose overlays and Dockerfiles describe how the app is deployed, never
  // what it compiles to.
  if (/^docker-compose[\w.-]*\.ya?ml$/.test(p)) return true;
  if (/^Dockerfile[\w.-]*$/.test(p)) return true;

  if (IRRELEVANT_FILES.has(p)) return true;
  if (IRRELEVANT_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;

  // The web tsconfig's own exclusions. Scoped to src/ and to `.test.ts(x)`
  // exactly as tsconfig writes them — e2e specs, the eval harness and
  // src/test-helpers/ are NOT excluded there, so they are NOT excluded here.
  if (/^packages\/web\/src\/.*\.test\.tsx?$/.test(p)) return true;

  return false;
}

/**
 * Every module specifier in `source` that resolves OUTSIDE packages/web.
 *
 * The point is the drift guard, not the resolution: hard-coding today's one
 * escape (the plugin manifests) would pin only today's, and the next relative
 * import out of the package would land in the build graph with the gate still
 * calling it irrelevant — green checks, silent hole. Deriving the escapes from
 * the source turns that into a failing test.
 *
 * Deliberately a regex over text rather than a parse: it needs to see a
 * type-only import exactly like a value one, and it runs over ~700 files on
 * every `pnpm test:scripts`.
 *
 * Matches the forms that make TypeScript RESOLVE a module — `from "…"`, a
 * side-effect `import "…"`, `import("…")`, `import x = require("…")` — and not a
 * bare `require("…")`. That exclusion is not a gap: the only bare require here
 * is `createRequire(import.meta.url)` in eval/__tests__/odoo-mock-eval-reset,
 * whose result is typed `any` and cast at the call site, so the mock server it
 * loads is a runtime dependency that `next build` never reads. Its own comment
 * says as much ("without a build-graph entanglement").
 *
 * @param {string} fromRepoPath repo-relative path of the importing file
 * @param {string} source its text
 * @returns {string[]} repo-relative, extension-preserving targets, deduplicated
 */
export function escapingImportTargets(fromRepoPath, source) {
  const dir = posix.dirname(fromRepoPath);
  const targets = [];
  const specifiers =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\bimport\s+[\w$]+\s*=\s*require\s*\(\s*)["']([^"'\n]+)["']/g;
  for (const [, specifier] of source.matchAll(specifiers)) {
    // Bare specifiers resolve through node_modules / tsconfig paths, never out
    // of the package by climbing; `@/…` is the web package's own alias.
    if (!specifier.startsWith(".")) continue;
    const resolved = posix.join(dir, specifier);
    if (resolved.startsWith("packages/web/")) continue;
    if (!targets.includes(resolved)) targets.push(resolved);
  }
  return targets;
}

/**
 * @param {string[]} paths repo-relative paths of every file the push changes
 * @returns {boolean} true when `pnpm build` must run before the push
 */
export function needsProductionBuild(paths) {
  const changed = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  // An empty list means we could not work out what the push contains (no
  // upstream, a force push, an unresolvable merge-base) — not that it contains
  // nothing. Build: a wasted build costs minutes, a client/server boundary
  // error reaching main costs a red CI run and a revert.
  if (changed.length === 0) return true;
  return changed.some((p) => !isBuildIrrelevant(p));
}

/**
 * Content identity of everything `next build` reads, so a push whose build input
 * is byte-identical to one that already built successfully can skip the rebuild.
 *
 * The relevance filter above only catches a push whose entire diff misses the
 * build — about 1 commit in 40 on this repo's history. What actually dominates
 * an agent's loop is re-pushing the same build input: amend/rebase cycles, a
 * follow-up docs commit, a test-only fix after review. Those all move the tree
 * hash but not the build's input, and the fingerprint is what tells them apart.
 *
 * @param {{path: string, oid: string}[]} entries every tracked file in the
 *   pushed commit, as `git ls-tree -r` reports it
 * @returns {string} hex digest over the build-relevant subset
 */
export function buildInputFingerprint(entries) {
  const relevant = entries
    .filter((e) => !isBuildIrrelevant(e.path))
    // Sort by path so git's listing order cannot change the digest.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash("sha256");
  for (const { path, oid } of relevant) {
    // NUL-delimited: neither a path nor a blob oid can contain it, so no crafted
    // filename can make two different trees hash alike and skip a real build.
    hash.update(`${path}\0${oid}\0`);
  }
  return hash.digest("hex");
}

/**
 * Whether the fingerprint of the pushed commit is a truthful description of what
 * `pnpm build` is about to compile — or just compiled.
 *
 * The two are not the same thing. `next build` reads the WORKING TREE, while the
 * fingerprint describes a COMMIT. They agree only when HEAD is the commit being
 * pushed and nothing is modified or untracked on top of it. Otherwise recording
 * a success would attach a passing build to a commit that was never the thing
 * built — and a later push of that commit elsewhere would skip on a guarantee
 * nobody ever established. Untracked files count: a new `page.tsx` nobody has
 * added yet is exactly the kind of file that breaks the build.
 *
 * When this is false the fingerprint is simply not used, in either direction: no
 * skip, and nothing recorded. The build runs, which is the safe answer.
 */
export function canTrustFingerprint(opts) {
  return opts.workingTreeClean === true && opts.headMatchesPushedTip === true;
}

/**
 * The fingerprint a run staged, together with the HEAD it was staged against.
 *
 * canTrustFingerprint above runs when the gate DECIDES — minutes before the
 * build it gates has finished. Editing files while a five-minute build runs is
 * ordinary work, and those edits are exactly what `next build` then compiled.
 * Promoting on the strength of the earlier check would credit the commit with a
 * build of different bytes, and a later push of that commit would skip on a
 * guarantee nobody established. So `--record` re-checks, and it needs to know
 * which HEAD the decision was made against.
 */
export function formatPendingRecord({ fingerprint, headOid }) {
  return `${fingerprint}\n${headOid}\n`;
}

/**
 * @returns {{fingerprint: string, headOid: string} | null} null for anything
 *   that is not both halves — including the bare fingerprint the first version
 *   of this file wrote, which must not read as valid and quietly restore the
 *   unchecked promotion.
 */
export function parsePendingRecord(text) {
  if (typeof text !== "string") return null;
  const [fingerprint, headOid] = text.trim().split("\n");
  if (!fingerprint || !headOid) return null;
  return { fingerprint: fingerprint.trim(), headOid: headOid.trim() };
}

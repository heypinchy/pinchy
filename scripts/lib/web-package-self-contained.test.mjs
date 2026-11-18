/**
 * `packages/web` must build from `packages/web` alone.
 *
 * `Dockerfile.pinchy` copies the workspace root manifests, `patches/`,
 * `packages/web` and a handful of plugin *manifests* — then runs
 * `cd packages/web && pnpm build`. It never copies `scripts/`. So a file that
 * `next build` type-checks may not import anything outside the package: it
 * resolves fine on a developer's machine and on `pnpm build`, and fails only
 * inside the image, several minutes into CI, as
 * `Cannot find module '../../scripts/lib/…'`.
 *
 * That is exactly how it shipped once (PR #930): the vitest integration config
 * imported a helper from `scripts/lib/`. Local `pnpm build` was green, because
 * the repo root is right there.
 *
 * The subtlety this guard encodes is WHICH files are affected. Importing
 * `scripts/lib/*.mjs` from `packages/web` is an established, fine pattern —
 * `db-password-resolver.test.ts` and friends do it — because `tsconfig.json`
 * EXCLUDES `src/**` test files, so `next build` never compiles them. The rule
 * is therefore not "no out-of-package imports" but "none from a file the build
 * actually compiles".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB = join(ROOT, "packages", "web");

/** Directories that hold no build input, or that are build output. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "coverage",
  "test-results",
  "playwright-report",
]);

/**
 * Does one path segment match one glob segment? `*` stands for any run of
 * characters within the segment; everything else is literal.
 *
 * Matched by hand rather than by building a RegExp from the pattern: escaping
 * a glob into a regex correctly means escaping every metacharacter, and doing
 * it partially is a real defect (CodeQL js/incomplete-sanitization caught this
 * file doing exactly that — it escaped `.` and `*` but not `\`).
 */
function segmentMatches(pattern, name) {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === name;
  if (!name.startsWith(parts[0])) return false;
  if (!name.endsWith(parts[parts.length - 1])) return false;

  let at = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  // The leading and trailing literals must not overlap on a short name.
  return at <= name.length - parts[parts.length - 1].length;
}

/** Does a `/`-split glob match a `/`-split path? `**` spans any depth. */
function pathMatches(patternSegments, pathSegments) {
  if (patternSegments.length === 0) return pathSegments.length === 0;

  const [head, ...rest] = patternSegments;
  if (head === "**") {
    for (let skip = 0; skip <= pathSegments.length; skip++) {
      if (pathMatches(rest, pathSegments.slice(skip))) return true;
    }
    return false;
  }
  if (pathSegments.length === 0) return false;
  if (!segmentMatches(head, pathSegments[0])) return false;
  return pathMatches(rest, pathSegments.slice(1));
}

/** `exclude` entries from tsconfig.json, as predicates over a web-relative path. */
function excludedBy(tsconfigText) {
  const excludes = JSON.parse(
    tsconfigText.replace(/^\s*\/\/.*$/gm, ""),
  ).exclude;
  return excludes.map((pattern) => {
    const segments = pattern.split("/");
    // A bare directory name excludes everything beneath it, which is how
    // `node_modules` is meant here.
    return (p) =>
      pathMatches(segments, p.split("/")) || p.startsWith(`${pattern}/`);
  });
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".next") {
      if (entry.isDirectory()) continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Static import/export specifiers that start with a relative path — the ones
 * TypeScript has to RESOLVE, and so the ones that can break the image build.
 *
 * A `createRequire(import.meta.url)` + `require("…")` call is deliberately not
 * one of them: it is a runtime call, TypeScript never resolves the string, and
 * `eval/__tests__/odoo-mock-eval-reset.test.ts` uses exactly that to reach the
 * mock server without entangling the build graph. Flagging it would be a false
 * positive against a documented technique.
 */
function relativeSpecifiers(text) {
  const out = [];
  const patterns = [
    /\bfrom\s+["'](\.[^"']*)["']/g,
    /\bimport\s+["'](\.[^"']*)["']/g,
  ];
  for (const rx of patterns) {
    for (const m of text.matchAll(rx)) out.push(m[1]);
  }
  return out;
}

/**
 * Paths outside `packages/web` that `Dockerfile.pinchy` copies into the build
 * stage, absolute. Derived from the Dockerfile rather than listed here, so the
 * guard tracks it: the plugin manifests are copied precisely BECAUSE
 * `plugin-manifest-loader.ts` imports them, and that import is legitimate.
 */
function pathsCopiedIntoImage() {
  const text = readFileSync(join(ROOT, "Dockerfile.pinchy"), "utf8");
  const copied = [];
  for (const line of text.split("\n")) {
    const m = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
    if (!m) continue;
    // Last token is the destination; everything before it is a source.
    const tokens = m[1].split(/\s+/);
    for (const src of tokens.slice(0, -1)) {
      copied.push(resolve(ROOT, src.replace(/\/$/, "")));
    }
  }
  return copied;
}

test("no file that next build compiles imports something the image lacks", () => {
  const isExcluded = excludedBy(
    readFileSync(join(WEB, "tsconfig.json"), "utf8"),
  );
  const copied = pathsCopiedIntoImage();
  const inImage = (target) =>
    target.startsWith(WEB) ||
    copied.some((src) => target === src || target.startsWith(`${src}/`));
  const offenders = [];

  for (const file of walk(WEB)) {
    const webRelative = relative(WEB, file).split("\\").join("/");
    if (isExcluded.some((matches) => matches(webRelative))) continue;

    for (const spec of relativeSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolve(dirname(file), spec);
      if (!inImage(target)) offenders.push(`${webRelative} -> ${spec}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These files are compiled by \`next build\` (tsconfig.json includes them) ` +
      `but import from outside packages/web:\n  ${offenders.join("\n  ")}\n` +
      `Dockerfile.pinchy copies only packages/web, so this builds locally and ` +
      `fails inside the image. Inline what you need, or move the file into the ` +
      `package — or, if it is a test, make sure tsconfig.json excludes it.`,
  );
});

test("the exclude patterns still match the files they are meant to", () => {
  // Without this, a tsconfig rename would make `isExcluded` match nothing, the
  // guard would start scanning excluded test files, and its failure would look
  // like a real violation. Both directions are checked: something that must be
  // excluded, and something that must NOT be.
  const isExcluded = excludedBy(
    readFileSync(join(WEB, "tsconfig.json"), "utf8"),
  );
  const excluded = (p) => isExcluded.some((matches) => matches(p));

  assert.ok(
    excluded("src/__tests__/lib/db-password-resolver.test.ts"),
    "test files must be excluded — they legitimately import scripts/lib",
  );
  assert.ok(excluded("vitest.config.ts"), "vitest.config.ts must be excluded");
  assert.ok(
    !excluded("vitest.integration.config.ts"),
    "vitest.integration.config.ts is NOT excluded — it is compiled by the build, " +
      "which is exactly why it must stay self-contained",
  );
  assert.ok(!excluded("src/lib/audit.ts"), "production source must be scanned");
});

test("the glob matcher handles the shapes tsconfig actually uses", () => {
  // `**` must span any depth, including none, and `*` must not leak across a
  // path separator. A matcher that quietly says "no" to everything would make
  // the guard scan excluded files and report false violations; one that says
  // "yes" to everything would switch the guard off entirely.
  const match = (pattern, path) =>
    pathMatches(pattern.split("/"), path.split("/"));

  assert.ok(match("src/**/*.test.ts", "src/a/b/c.test.ts"), "deep nesting");
  assert.ok(match("src/**/*.test.ts", "src/c.test.ts"), "** spans zero dirs");
  assert.ok(match("vitest.config.ts", "vitest.config.ts"), "literal");

  assert.ok(!match("src/**/*.test.ts", "src/c.ts"), "non-test file");
  assert.ok(!match("src/**/*.test.ts", "eval/c.test.ts"), "wrong root");
  assert.ok(
    !match("vitest.config.ts", "vitest.integration.config.ts"),
    "prefix",
  );
  assert.ok(!match("src/*.ts", "src/a/b.ts"), "* must not cross a separator");

  // A dot in the pattern is a literal dot, not "any character".
  assert.ok(!match("vitest.config.ts", "vitestxconfig.ts"), "dot is literal");
});

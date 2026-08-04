#!/usr/bin/env node
/**
 * Build-time release guard: asserts that the version field of both
 * package.json (root) and packages/web/package.json matches the release tag
 * before any Docker image is built and pushed.
 *
 * Usage: node scripts/assert-package-version.mjs <tag>
 *   e.g. node scripts/assert-package-version.mjs v0.5.5
 *
 * Exits 0 when both versions match the tag, 1 (with a ::error:: annotation
 * for GitHub Actions) otherwise. See assertVersionMatchesTag in
 * lib/release-logic.mjs for the v0.5.5 regression this guards against.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersionMatchesTag } from "./lib/release-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// `--root <dir>` exists for the tests. Since #1044 the working tree declares
// `<next>-dev` at every moment that is not a release commit, so the repo itself
// can no longer stand in for the passing case — and must not: a development
// tree failing a release build gate is the correct answer, not a broken test.
// The tests point this at a fixture for the matching case.
const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const root = rootFlag === -1 ? ROOT : resolve(argv[rootFlag + 1] ?? "");
const tag = argv.filter(
  (_, i) => rootFlag === -1 || (i !== rootFlag && i !== rootFlag + 1),
)[0];

if (!tag) {
  process.stderr.write(
    "Usage: assert-package-version.mjs <tag> [--root <dir>]\n",
  );
  process.exit(1);
}

const readVersion = (relPath) =>
  JSON.parse(readFileSync(resolve(root, relPath), "utf8")).version;

try {
  assertVersionMatchesTag({
    tag,
    pkgVersion: readVersion("package.json"),
    webVersion: readVersion("packages/web/package.json"),
  });
  process.stdout.write(`package versions match ${tag}\n`);
} catch (err) {
  process.stdout.write(`::error::${err.message}\n`);
  process.exit(1);
}

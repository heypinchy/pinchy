#!/usr/bin/env node
/**
 * Prints the newest release `upgrading.mdx` records as shipped (e.g. `0.9.1`),
 * or exits 1 when it records none.
 *
 * This is `inject-version.sh`'s last resort — the answer to "which version do
 * these docs describe?" when neither PINCHY_VERSION nor a git tag on HEAD says.
 * That used to be `packages/web/package.json`, and it was right until #1044
 * split the two questions apart: since then package.json answers "what is this
 * tree?" and carries `<next>-dev` at every moment that is not a release commit.
 * `%%PINCHY_VERSION%%` renders into `docker pull` lines and raw.githubusercontent
 * URLs, so it needs the other question's answer — a tag that exists.
 *
 * upgrading.mdx's newest frozen section is that answer, offline: it is in the
 * repo, needs no tags fetched, and a release must update it anyway. Reading it
 * here rather than re-deriving it keeps `version-identity.mjs` and the docs
 * build on one reading, which is the whole point of that guard.
 *
 * Usage: node docs/scripts/newest-released-version.mjs [repoRoot]
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { newestFrozenRelease } from "../../scripts/lib/version-identity.mjs";
import { UPGRADING_MDX_PATH } from "../../scripts/lib/upgrading-released-sections.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? resolve(here, "..", "..");

let mdx;
try {
  mdx = readFileSync(resolve(root, UPGRADING_MDX_PATH), "utf8");
} catch (err) {
  process.stderr.write(`Cannot read ${UPGRADING_MDX_PATH}: ${err.message}\n`);
  process.exit(1);
}

const version = newestFrozenRelease(mdx);
if (!version) {
  process.stderr.write(
    `${UPGRADING_MDX_PATH} records no frozen "## Upgrading from vA to vB" section, ` +
      `so nothing has shipped yet and there is no released version to name.\n`,
  );
  process.exit(1);
}

process.stdout.write(version);

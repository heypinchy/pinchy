#!/usr/bin/env node
/**
 * Prints the moving image tag for the branch being built and writes
 * `moving=<tag>` to $GITHUB_OUTPUT for pre-release.yml's build step to tag with
 * (e.g. `main` → `next`, `release/0.9` → `rc-0.9`).
 *
 * Pure decision logic lives in lib/release-logic.mjs (movingTagForRef) and is
 * unit-tested; this wrapper only does the I/O. Keeping the derivation in one
 * place is why the workflow calls this script instead of inlining the bash — a
 * second copy would be free to drift, and staging pins the tag it produces.
 *
 * Usage: node scripts/moving-tag.mjs "$GITHUB_REF_NAME"
 */

import { appendFileSync } from "node:fs";
import { movingTagForRef } from "./lib/release-logic.mjs";

const refName = process.argv[2];
if (!refName) {
  process.stderr.write(
    "Usage: node scripts/moving-tag.mjs <ref-name>  (e.g. main, release/0.9)\n",
  );
  process.exit(1);
}

const moving = movingTagForRef(refName);
console.log(`moving tag for ${refName}: ${moving}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `moving=${moving}\n`);
}

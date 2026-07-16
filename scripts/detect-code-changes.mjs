#!/usr/bin/env node
/**
 * Reads changed file paths on stdin (one per line, as `git diff --name-only`
 * emits them) and writes `code=true|false` to $GITHUB_OUTPUT for ci.yml's
 * `changes` job to gate the expensive job matrix on.
 *
 * Pure decision logic lives in lib/ci-path-filter.mjs and is unit-tested; this
 * wrapper only does the I/O.
 */

import { appendFileSync } from "node:fs";
import { hasCodeChanges } from "./lib/ci-path-filter.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const paths = (await readStdin()).split("\n");
const code = hasCodeChanges(paths);

const listed = paths.map((p) => p.trim()).filter(Boolean);
console.log(`Changed files (${listed.length}):`);
for (const p of listed) console.log(`  ${p}`);
console.log(
  code
    ? "→ code=true: running the full CI matrix."
    : "→ code=false: docs-only change, skipping the build/E2E matrix. " +
        "Required checks still run and report."
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`);
}

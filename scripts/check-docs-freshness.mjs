#!/usr/bin/env node
/**
 * Docs freshness check (weekly cron, not a PR gate).
 *
 * Every forward-looking sentence in the docs cites a tracking issue — that is
 * what `scripts/lib/docs-consistency.mjs` enforces offline on each PR. This job
 * is the payoff: it asks GitHub which of those issues have closed, and reports
 * the sentences that are now promising something the repo already shipped.
 *
 * It is a cron rather than a PR gate on purpose. The question needs the
 * network, the answer changes without anyone touching the docs, and a check
 * that can go red between two identical commits does not belong in front of a
 * merge button.
 *
 * The 2026-07-30 audit found two of these by hand — a knowledge-base progress
 * UI "planned for a later phase" that had shipped (and was described 120 lines
 * further up the same page), and inbox automations that "will read [the org
 * timezone] when they ship", written after they shipped.
 *
 * Usage: node scripts/check-docs-freshness.mjs [--repo owner/name]
 * Requires `gh` on PATH and authenticated (GITHUB_TOKEN in CI).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  extractForwardClaims,
  findResolvedForwardClaims,
} from "./lib/docs-consistency.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(REPO_ROOT, "docs/src/content/docs");

const repoArgIndex = process.argv.indexOf("--repo");
const repo =
  (repoArgIndex !== -1 ? process.argv[repoArgIndex + 1] : undefined) ??
  process.env.GITHUB_REPOSITORY ??
  "heypinchy/pinchy";

/** @returns {Array<{path: string, source: string}>} */
function readDocPages(dir = DOCS) {
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

const claims = extractForwardClaims(readDocPages());
const issueNumbers = [...new Set(claims.flatMap((c) => c.issues))].sort(
  (a, b) => a - b,
);

if (issueNumbers.length === 0) {
  process.stdout.write("✓ docs-freshness: no tracked forward-looking claims\n");
  process.exit(0);
}

/** @type {Record<number, "open"|"closed">} */
const states = {};
for (const number of issueNumbers) {
  try {
    const state = execFileSync(
      "gh",
      ["api", `repos/${repo}/issues/${number}`, "--jq", ".state"],
      { encoding: "utf8" },
    ).trim();
    // An unknown state is treated as unknown, not as open: leaving it out of
    // `states` is what keeps findResolvedForwardClaims from reading silence as
    // a verdict either way.
    if (state === "open" || state === "closed") states[number] = state;
  } catch {
    process.stdout.write(
      `  (could not read issue #${number} — skipping it this run)\n`,
    );
  }
}

const stale = findResolvedForwardClaims(claims, states);

const summary = [];
if (stale.length === 0) {
  summary.push(
    `✓ docs-freshness: ${claims.length} tracked claim(s), none whose issues have all closed.`,
  );
} else {
  summary.push(
    `## Docs promising something that already shipped (${stale.length})`,
    "",
    "Each line cites a tracking issue that is now **closed**. Either the docs",
    "describe the shipped behaviour now, or the sentence should go.",
    "",
  );
  for (const c of stale) {
    summary.push(
      `- \`${c.path}:${c.line}\` — cites ${c.issues.map((n) => `#${n}`).join(", ")}`,
      `  > ${c.text}`,
    );
  }
}

const text = summary.join("\n");
process.stdout.write(`${text}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

process.exit(stale.length === 0 ? 0 : 1);

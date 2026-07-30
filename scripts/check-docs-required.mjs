#!/usr/bin/env node
/**
 * Docs-required guard (CI, pull requests only).
 *
 * Fails when a PR moves a user-visible surface — an API route, the tool
 * registry, an agent template, the audit event catalogue, the settings
 * navigation, a plugin's declared tools — without touching a single file under
 * `docs/`.
 *
 * The `docs-coverage` guard catches a *list* that has drifted. This catches the
 * class that no identifier match can see: prose that quietly became untrue.
 *
 * Usage:
 *   node scripts/check-docs-required.mjs [--base <ref>]
 *
 * Base ref resolution: --base arg > $BASE_REF env > "origin/main".
 *
 * Override (either is sufficient):
 *   - Apply the `docs-not-needed` PR label (CI passes $DOCS_NOT_NEEDED).
 *   - Add a commit trailer stating what makes the change invisible to a reader:
 *       Docs-not-needed: gateway-only ingress, no reader-facing path
 *
 * See AGENTS.md § "A User-Visible Change Needs A Docs Change".
 */

import { execFileSync } from "node:child_process";
import {
  analyzeChangedPaths,
  formatFailure,
  parseDocsOverride,
} from "./lib/docs-required.mjs";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(args) {
  try {
    return git(args).trim();
  } catch {
    return "";
  }
}

const baseArgIndex = process.argv.indexOf("--base");
const base =
  (baseArgIndex !== -1 ? process.argv[baseArgIndex + 1] : undefined) ??
  process.env.BASE_REF ??
  "origin/main";

// Same two-dot-only rule as check-test-deletions.mjs: the three-dot form needs
// a merge-base and throws in a shallow CI checkout.
const mergeBase = tryGit(["merge-base", base, "HEAD"]);
const diff = mergeBase
  ? git(["diff", "--name-only", "-M", `${mergeBase}..HEAD`])
  : git(["diff", "--name-only", "-M", base, "HEAD"]);

if (!mergeBase) {
  process.stdout.write(
    `::warning::no merge-base with ${base}; comparing tips instead\n`,
  );
}

const changed = diff.split("\n").filter(Boolean);
const analysis = analyzeChangedPaths(changed);
const failure = formatFailure(analysis);

if (!failure) {
  process.stdout.write("✓ docs-required: nothing to ask for\n");
  process.exit(0);
}

const messages = mergeBase
  ? git(["log", "-z", "--format=%B", `${mergeBase}..HEAD`]).split("\u0000")
  : git(["log", "-z", "--format=%B", "-n", "200", "HEAD"]).split("\u0000");

const override = parseDocsOverride({
  envValue: process.env.DOCS_NOT_NEEDED,
  messages,
});

if (override.allowed) {
  process.stdout.write(`✓ docs-required: waived — ${override.reason}\n`);
  process.exit(0);
}

process.stderr.write(`✖ docs-required\n\n${failure}\n`);
process.exit(1);

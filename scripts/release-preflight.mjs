#!/usr/bin/env node
/**
 * Pinchy release preflight (advisory)
 *
 * Usage: pnpm release:preflight <version> [--verified=<sha>]
 *   e.g. pnpm release:preflight 0.7.0
 *
 * Prints, before you cut a release:
 *   1. Auto-checked gates (branch, clean tree, tag free, upgrade-notes section,
 *      CI status) — the same hard gates `pnpm release` enforces, surfaced early.
 *   2. The MANUAL gates that the release script CANNOT enforce — and that get
 *      silently skipped if they live only as prose. Each is printed as an
 *      unchecked `[ ]` item to be verified on staging (:next) before releasing:
 *        - a release-specific checklist DERIVED FROM THIS RELEASE'S UPGRADE NOTES
 *          (the bespoke part — different every release),
 *        - the standard regression smoke,
 *        - the PWA install check.
 *
 * This is advisory output — it never mutates anything and always exits 0. The
 * forcing function is the cut-release skill: turn every `[ ]` below into a
 * blocking task and make the `pnpm release` task depend on them.
 *
 * After verifying on staging, cut with:
 *   pnpm release <version> --verified=$(git rev-parse HEAD)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAndValidateVersion,
  buildTagName,
  assertUpgradingSectionExists,
  deriveStagingChecklist,
  checkReleaseVerification,
} from "./lib/release-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function tryExec(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || e.message || "").toString().trim() };
  }
}

const out = (s = "") => process.stdout.write(`${s}\n`);
const mark = (ok) => (ok === true ? "✓" : ok === false ? "✗" : "❓");

// ─── Argument ────────────────────────────────────────────────────────────────

const input = process.argv[2];
const verifiedArg = (process.argv.find((a) => a.startsWith("--verified=")) || "").split("=")[1];
if (!input) {
  process.stderr.write("Usage: pnpm release:preflight <version> [--verified=<sha>]\n");
  process.exit(1);
}

let version;
try {
  version = parseAndValidateVersion(input);
} catch (e) {
  process.stderr.write(`✖ ${e.message}\n`);
  process.exit(1);
}
const tag = buildTagName(version);

const prevTag = tryExec("git describe --tags --abbrev=0");
const prevVersion = prevTag.ok ? prevTag.out.replace(/^v/, "") : null;

out(`\nRelease preflight — ${tag}${prevVersion ? ` (from v${prevVersion})` : ""}\n`);

// ─── Auto-checked gates ───────────────────────────────────────────────────────

const branch = tryExec("git branch --show-current");
const status = tryExec("git status --porcelain");
const tags = tryExec("git tag --list");

let upgradeNotesOk = false;
let upgradeNotesMsg = "";
if (prevVersion) {
  try {
    const mdx = readFileSync(
      resolve(ROOT, "docs/src/content/docs/guides/upgrading.mdx"),
      "utf8",
    );
    assertUpgradingSectionExists(mdx, prevVersion, version);
    upgradeNotesOk = true;
  } catch (e) {
    upgradeNotesMsg = e.message.split("\n")[0];
  }
} else {
  upgradeNotesMsg = "no previous tag found (cannot resolve the 'from' version)";
}

const ci = tryExec(
  'gh run list --branch main --workflow CI --limit 1 --json conclusion --jq ".[0].conclusion"',
);
const ciState = !ci.ok ? null : ci.out === "success" ? true : false;

out("Auto-checked (also enforced by `pnpm release`):");
out(`  ${mark(branch.out === "main")} on main branch${branch.out === "main" ? "" : ` (on: ${branch.out || "?"})`}`);
out(`  ${mark(status.ok && status.out === "")} working tree clean`);
out(`  ${mark(tags.ok && !tags.out.split("\n").includes(tag))} tag ${tag} is free`);
out(`  ${mark(upgradeNotesOk)} upgrade-notes section present${upgradeNotesOk ? "" : ` — ${upgradeNotesMsg}`}`);
out(`  ${mark(ciState)} CI green on main${ciState === null ? " (could not query gh — check manually)" : ci.out ? ` (${ci.out})` : ""}`);

// ─── Manual gates — verify on staging, then check each off ────────────────────

out("");
out("Manual gates — verify on staging (:next) and CHECK EACH OFF before `pnpm release`:");
out("(the skill turns each `[ ]` into a blocking task that `pnpm release` waits on)");

out("");
out("  Release-specific (from this release's upgrade notes):");
let checklist = [];
if (prevVersion) {
  try {
    const mdx = readFileSync(
      resolve(ROOT, "docs/src/content/docs/guides/upgrading.mdx"),
      "utf8",
    );
    checklist = deriveStagingChecklist(mdx, prevVersion, version);
  } catch {
    // handled below by the empty-list branch
  }
}
if (checklist.length === 0) {
  out("    (!) no upgrade-notes section resolved — write it first; nothing to verify yet");
} else {
  for (const item of checklist) {
    out(`    [ ] ${item.breaking ? "[BREAKING] " : ""}${item.title}`);
  }
}

out("");
out("  Standard regression smoke:");
out("    [ ] Smithers chat round-trip");
out("    [ ] One live integration");
out("    [ ] One custom agent with existing chat history");

out("");
out("  PWA install check (manifest fields are already CI-gated):");
out("    [ ] Chrome desktop: install icon appears, opens a standalone window");
out("    [ ] iOS Safari: Share → Add to Home Screen opens full-screen with splash");

// ─── Attestation echo ─────────────────────────────────────────────────────────

out("");
const head = tryExec("git rev-parse HEAD");
if (verifiedArg !== undefined) {
  const v = checkReleaseVerification({ verifiedSha: verifiedArg, headSha: head.out });
  out(`Attestation: ${mark(v.ok)} ${v.message}`);
} else if (head.ok) {
  out(`After verifying on staging, cut with:\n  pnpm release ${version} --verified=${head.out.slice(0, 12)}`);
}
out("");

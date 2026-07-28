#!/usr/bin/env node
/**
 * Reads git's pre-push stdin protocol and prints `build` or `skip` on stdout for
 * .husky/pre-push to branch on. With `--record`, promotes the fingerprint the
 * preceding run staged — call it only after `pnpm build` exited 0.
 *
 * Git feeds a pre-push hook one line per ref being pushed:
 *
 *     <local ref> <local oid> <remote ref> <remote oid>
 *
 * That gives the exact commit range the push adds. A remote oid of all zeros
 * means the branch does not exist upstream yet, so there is no range — we fall
 * back to the merge-base against the default branch, i.e. everything this branch
 * introduces.
 *
 * Two independent reasons to skip, both in lib/prepush-build-gate.mjs:
 *   1. nothing in the pushed diff reaches `next build` at all;
 *   2. the build input is byte-identical to one that already built here.
 *
 * The last-good fingerprint lives in the worktree's own git dir, never in the
 * work tree, so it is not committable and does not travel between worktrees —
 * each worktree has its own node_modules and proves its own build.
 *
 * FAIL OPEN, ALWAYS. Anything unexpected — no stdin, an unresolvable range, a
 * git invocation that errors — prints `build`. The hook likewise builds on any
 * output that is not exactly `skip`, so even a crash in this file still runs the
 * build. Losing minutes is recoverable; letting a client/server boundary error
 * through the one local check that sees it is not.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  needsProductionBuild,
  buildInputFingerprint,
  canTrustFingerprint,
} from "./lib/prepush-build-gate.mjs";

const ZERO_OID = /^0+$/;
const DEFAULT_BRANCH_CANDIDATES = ["origin/main", "main"];
const LAST_GOOD = "pinchy-prepush-build.ok";
const STAGED = "pinchy-prepush-build.pending";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitDir() {
  return git(["rev-parse", "--absolute-git-dir"]).trim();
}

function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

// --record: the build we staged a fingerprint for has just succeeded.
if (process.argv.includes("--record")) {
  try {
    const dir = gitDir();
    renameSync(join(dir, STAGED), join(dir, LAST_GOOD));
  } catch {
    // Nothing staged, or the git dir moved. The only consequence is that the
    // next push rebuilds, which is the safe direction.
  }
  process.exit(0);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The commit to diff a not-yet-pushed branch against, or null. */
function baseForNewBranch(localOid) {
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    try {
      return git(["merge-base", candidate, localOid]).trim();
    } catch {
      // Not a resolvable ref in this clone — try the next candidate.
    }
  }
  return null;
}

/** The refs this push actually carries content for. */
function pushedTips(stdin) {
  const tips = [];
  for (const line of stdin.split("\n")) {
    if (!line.trim()) continue;
    const [, localOid, , remoteOid] = line.trim().split(/\s+/);
    // A deletion (`git push --delete`) pushes a zero local oid and no content.
    if (!localOid || ZERO_OID.test(localOid)) continue;
    tips.push({ localOid, remoteOid });
  }
  return tips;
}

function changedPaths(tips) {
  const paths = new Set();
  for (const { localOid, remoteOid } of tips) {
    const base =
      remoteOid && !ZERO_OID.test(remoteOid)
        ? remoteOid
        : baseForNewBranch(localOid);
    if (!base) return null;

    let diff;
    try {
      diff = git(["diff", "--name-only", `${base}..${localOid}`]);
    } catch {
      return null;
    }
    for (const p of diff.split("\n")) if (p.trim()) paths.add(p.trim());
  }
  return [...paths];
}

/**
 * Fingerprint of the pushed tip's build input, or null whenever it would not
 * truthfully describe what `pnpm build` compiles — see canTrustFingerprint.
 */
function fingerprintOf(tips) {
  if (tips.length !== 1) return null; // a multi-ref push has no single "the" tree
  try {
    const trustworthy = canTrustFingerprint({
      // --porcelain lists modified AND untracked files; both change the build.
      workingTreeClean: git(["status", "--porcelain"]).trim() === "",
      headMatchesPushedTip:
        git(["rev-parse", "HEAD"]).trim() === tips[0].localOid,
    });
    if (!trustworthy) return null;
  } catch {
    return null;
  }
  try {
    const entries = git(["ls-tree", "-r", tips[0].localOid])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // "<mode> <type> <oid>\t<path>"
        const tab = line.indexOf("\t");
        return {
          path: line.slice(tab + 1),
          oid: line.slice(0, tab).split(/\s+/)[2],
        };
      });
    return buildInputFingerprint(entries);
  } catch {
    return null;
  }
}

let verdict = true;
let reason = "could not determine what this push changes";
let fingerprint = null;

try {
  const tips = pushedTips(await readStdin());
  if (tips.length > 0) {
    const paths = changedPaths(tips);
    fingerprint = fingerprintOf(tips);
    const lastGood = fingerprint
      ? readIfPresent(join(gitDir(), LAST_GOOD))
      : null;

    if (fingerprint && fingerprint === lastGood) {
      verdict = false;
      reason =
        "this exact build input already built successfully in this worktree";
    } else if (paths && paths.length > 0) {
      verdict = needsProductionBuild(paths);
      reason = verdict
        ? `${paths.length} changed file(s), at least one reaches the Next.js build`
        : `${paths.length} changed file(s), none of them reach the Next.js build`;
    } else if (paths) {
      // An empty diff is not proof that nothing changed — it is also what an
      // already-merged branch or a range we resolved wrongly looks like.
      reason = "the pushed range resolved to no files — building to stay safe";
    }
  }
} catch (err) {
  reason = `gate errored (${err.message}) — building anyway`;
}

// Stage the fingerprint for --record to promote once the build succeeds. A
// stale staged value from an earlier failed build must not survive, so an
// unknown fingerprint clears it rather than leaving it in place.
try {
  const staged = join(gitDir(), STAGED);
  if (verdict && fingerprint) writeFileSync(staged, `${fingerprint}\n`);
  else rmSync(staged, { force: true });
} catch {
  // A read-only or missing git dir only costs the next push a rebuild.
}

console.error(
  verdict
    ? `ℹ pre-push: running the production build — ${reason}`
    : `ℹ pre-push: skipping the production build — ${reason}`,
);
console.log(verdict ? "build" : "skip");

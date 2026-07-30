#!/usr/bin/env node
/**
 * Claude Code `PreToolUse` hook: no PR for a user-visible change until the
 * docs have had a reading pass.
 *
 * Wired in `.claude/settings.json` against `Bash(gh pr create*)`. Reads the
 * hook payload on stdin and answers with a `permissionDecision`, so a refusal
 * arrives as an instruction the agent can act on rather than an error.
 *
 * This is the trigger the `review-docs` skill was missing. Without it the skill
 * is a sentence in AGENTS.md, and this repo has measured what those are worth.
 *
 * Fails OPEN. A hook that breaks must not make it impossible to open a pull
 * request — if git is unreachable or the payload is malformed, the honest
 * answer is to get out of the way, not to hold the release hostage.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  candidateBaseRefs,
  decideDocsReview,
  isPrCreateCommand,
  parseBaseRef,
} from "../lib/docs-review-hook.mjs";
import {
  analyzeChangedPaths,
  parseDocsOverride,
} from "../lib/docs-required.mjs";

function allow() {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    }),
  );
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Silence git's own stderr: probing two spellings of the base ref means
    // one `fatal: Not a valid object name` is the NORMAL path, and printing it
    // would make a working hook look broken.
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  allow();
}

const command = payload?.tool_input?.command ?? "";
if (!isPrCreateCommand(command)) allow();

try {
  const headSha = git(["rev-parse", "HEAD"]);

  // `--base main` may name a branch that isn't checked out (so `origin/main`
  // is the ref that resolves) or a tag (where `origin/<tag>` does not exist).
  // Try both spellings rather than guessing which one this is.
  let mergeBase = "";
  for (const ref of candidateBaseRefs(parseBaseRef(command))) {
    try {
      mergeBase = git(["merge-base", ref, "HEAD"]);
      break;
    } catch {
      // try the next spelling
    }
  }
  // Unknown base — no diff to reason about, so no basis to refuse.
  if (!mergeBase) allow();

  const changed = git(["diff", "--name-only", "-M", `${mergeBase}..HEAD`])
    .split("\n")
    .filter(Boolean);
  const { surfaces } = analyzeChangedPaths(changed);

  let markedSha = null;
  try {
    markedSha = readFileSync(
      git(["rev-parse", "--git-path", "pinchy-docs-review"]),
      "utf8",
    );
  } catch {
    // No marker yet — that is the normal first pass, not an error.
  }

  const override = parseDocsOverride({
    messages: [git(["log", "--format=%B", `${mergeBase}..HEAD`])],
  });

  const decision = decideDocsReview({ surfaces, headSha, markedSha, override });
  if (decision.allow) allow();
  deny(decision.reason);
} catch {
  allow();
}

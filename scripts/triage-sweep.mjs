#!/usr/bin/env node
/**
 * Reads every open issue and prints the triage sweep as markdown.
 *
 * Thin on purpose: paginate, decode, print. Every rule lives in
 * scripts/lib/triage-sweep.mjs where `pnpm test:scripts` can reach it.
 *
 * Usage:  node scripts/triage-sweep.mjs [--limit N]
 *
 * Unlike the other triage scripts this one runs on a laptop, not in Actions,
 * so GITHUB_TOKEN and GITHUB_REPOSITORY are not in the environment. It borrows
 * both from an authenticated `gh` rather than asking anyone to export a
 * personal token — the CLI is already signed in, and a token that never lands
 * in a shell history is one that cannot leak from one.
 */

import { execFileSync } from "node:child_process";
import { graphql, currentRepo } from "./lib/github-api.mjs";
import {
  SWEEP_QUERY,
  parseSweepResponse,
  classifyIssues,
  formatSweepReport,
} from "./lib/triage-sweep.mjs";

function fromGh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(
      `Could not read this from the gh CLI (\`gh ${args.join(" ")}\`). ` +
        `Run \`gh auth login\` first.\n${error.message}`,
    );
  }
}

if (!process.env.GITHUB_TOKEN) {
  process.env.GITHUB_TOKEN = fromGh(["auth", "token"]);
}
if (!process.env.GITHUB_REPOSITORY) {
  process.env.GITHUB_REPOSITORY = fromGh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
}

const limitFlag = process.argv.indexOf("--limit");
const limit =
  limitFlag === -1 ? Infinity : Number(process.argv[limitFlag + 1] ?? NaN);
if (!(limit > 0)) {
  // NaN fails this comparison too, which is the point: `--limit abc` must stop
  // rather than silently sweep zero issues and report a clean tracker.
  throw new Error(
    `--limit needs a positive number, got ${process.argv[limitFlag + 1]}`,
  );
}

const { owner, name } = currentRepo();
const issues = [];
let cursor = null;

do {
  const response = await graphql(SWEEP_QUERY, { owner, name, cursor });
  issues.push(...parseSweepResponse(response));
  const { hasNextPage, endCursor } = response.data.repository.issues.pageInfo;
  cursor = hasNextPage ? endCursor : null;
} while (cursor && issues.length < limit);

process.stdout.write(formatSweepReport(classifyIssues(issues.slice(0, limit))));
process.stdout.write("\n");

#!/usr/bin/env node
/**
 * Labels a freshly opened issue as `external` + `triage` when it came from
 * outside the team.
 *
 * Half of why #849 went unanswered: it arrived through the in-app deeplink,
 * which set no labels at all, so it appeared in no triage filter. That hole is
 * fixed at the source too (buildGitHubIssueUrl), but this catches every other
 * path into the tracker — the web UI, the API, a template we add later.
 */

import { readFileSync } from "node:fs";
import {
  annotateWriteAccess,
  isExternalIssue,
  parseIssueEvent,
} from "./lib/issue-triage.mjs";
import {
  addLabels,
  createWriteAccessResolver,
  currentRepo,
  ensureLabel,
} from "./lib/github-api.mjs";

const EXTERNAL_LABEL = {
  name: "external",
  color: "1D76DB",
  description: "Reported from outside the team; owes the reporter a reply",
};
const LABELS = ["external", "triage"];

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error(
      "GITHUB_EVENT_PATH is not set — this script runs on an `issues` event",
    );
  }

  const repo = currentRepo();
  const [issue] = await annotateWriteAccess(
    [parseIssueEvent(JSON.parse(readFileSync(eventPath, "utf8")))],
    createWriteAccessResolver(repo),
  );

  // The webhook's `author_association` is written from the app's point of
  // view, which cannot see a private org membership either — so without the
  // lookup this labels the team's own issues `external`, as it did to four
  // of them on 2026-08-05.
  if (!isExternalIssue(issue)) {
    console.log(
      `#${issue.number} was opened by @${issue.authorLogin} (team) — no labels added.`,
    );
    return;
  }

  await ensureLabel(repo, EXTERNAL_LABEL);
  await addLabels(repo, issue.number, LABELS);

  console.log(
    `#${issue.number} from @${issue.authorLogin} labelled: ${LABELS.join(", ")}`,
  );
}

await main();

#!/usr/bin/env node
/**
 * Fails when an outside reporter has been waiting too long for a first reply.
 *
 * The failure IS the notification: GitHub emails the repository owner when a
 * scheduled workflow fails, and the run stays red until somebody answers. No
 * new service, no secret, no dashboard nobody opens.
 *
 * #849 is why this exists — a stranger reported a real setup bug and waited a
 * week because nothing turned red.
 */

import { appendFileSync } from "node:fs";
import {
  annotateWriteAccess,
  findUnansweredIssues,
  formatOverdueSummary,
  parseIssuesResponse,
  parsePageInfo,
} from "./lib/issue-triage.mjs";
import {
  createWriteAccessResolver,
  currentRepo,
  graphql,
} from "./lib/github-api.mjs";

/**
 * Passed on as given, not pre-converted: findUnansweredIssues rejects anything
 * that is not a positive finite number, and it can only name the offending
 * value in its error if it still has the string. `Number("48h")` is NaN, and a
 * NaN reads back as "null" — the one detail the reader needs, gone.
 */
const GRACE_HOURS = process.env.TRIAGE_GRACE_HOURS ?? 48;

/**
 * Guards against an unbounded loop if the cursor ever fails to advance. At
 * 100 issues per page this covers 5000 open issues — far past anything real,
 * and it fails loudly rather than truncating.
 */
const MAX_PAGES = 50;

const QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          url
          createdAt
          authorAssociation
          author { login }
          # An issue with more than 100 comments and not one of them from the
          # team is not a case worth engineering for. Note which way this
          # errs: a missed maintainer reply keeps the sweep RED, so the worst
          # outcome is an alarm we clear by closing the issue — never a
          # reporter who silently drops out of the report.
          comments(first: 100) {
            nodes {
              authorAssociation
              author { login }
            }
          }
        }
      }
    }
  }
`;

/** Walks every page of open issues. Partial coverage would be a silent lie. */
async function fetchAllOpenIssues({ owner, name }) {
  const issues = [];
  let after = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await graphql(QUERY, { owner, name, after });
    issues.push(...parseIssuesResponse(response));

    const { hasNextPage, endCursor } = parsePageInfo(response);
    if (!hasNextPage) return issues;
    after = endCursor;
  }

  throw new Error(
    `Stopped after ${MAX_PAGES} pages of open issues — refusing to report on a partial tracker.`,
  );
}

function report(summary) {
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

async function main() {
  const repo = currentRepo();
  const issues = await fetchAllOpenIssues(repo);
  console.log(
    `Checked ${issues.length} open issues in ${repo.owner}/${repo.name}.`,
  );

  // The association this token was given is not the last word on who is on
  // the team — see createWriteAccessResolver. Without this step the sweep
  // reports the whole tracker.
  const known = await annotateWriteAccess(
    issues,
    createWriteAccessResolver(repo),
  );

  const overdue = findUnansweredIssues(known, {
    now: new Date(),
    graceHours: GRACE_HOURS,
  });

  report(formatOverdueSummary(overdue));

  if (overdue.length > 0) {
    console.error(
      `\n${overdue.length} external issue(s) have waited more than ${GRACE_HOURS}h for a first reply.\n` +
        "Reply to each one (or close it with a reason) — this check stays red until you do.",
    );
    process.exitCode = 1;
  }
}

await main();

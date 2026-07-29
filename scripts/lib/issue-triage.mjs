/**
 * Decides which open issues from outside the team are still waiting on us.
 *
 * This exists because #849 sat unanswered for a week. Nothing was broken —
 * a stranger reported a real bug, it arrived without labels (the in-app
 * deeplink didn't set any), and it simply scrolled out of view. Good will is
 * not a mechanism; a check that goes red is.
 *
 * The rule is deliberately blunt: an outside reporter is waiting until
 * somebody with write access has said something. There is no "acknowledged"
 * label, no assignee carve-out, no snooze. If we do not want to answer, the
 * honest move is to close the issue with a reason — not to teach the sweep a
 * way to look away.
 */

/**
 * GitHub's `authorAssociation` values that mean "has write access to this
 * repo". Everything else — NONE, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR — is
 * somebody we owe an answer. CONTRIBUTOR is the subtle one: it only means the
 * person had a PR merged at some point, not that they are on the team.
 */
export const TEAM_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** GitHub renders every bot identity with this login suffix. */
function isBot(login) {
  return typeof login === "string" && login.endsWith("[bot]");
}

function isTeam({ authorLogin, authorAssociation }) {
  return isBot(authorLogin) || TEAM_ASSOCIATIONS.has(authorAssociation);
}

/**
 * True when an outside human opened this issue. Bots are excluded on purpose:
 * automation files issues under an identity with no team association, and
 * counting those would leave the sweep permanently red over reports no human
 * is waiting on.
 */
export function isExternalIssue(issue) {
  return !isTeam(issue);
}

/** True once anyone with write access has commented. */
export function hasMaintainerReply(issue) {
  return (issue.comments ?? []).some(
    (comment) =>
      !isBot(comment.authorLogin) &&
      TEAM_ASSOCIATIONS.has(comment.authorAssociation),
  );
}

const MS_PER_DAY = 24 * 3600 * 1000;

/**
 * Returns the external issues that have gone unanswered past the grace
 * period, longest wait first, each annotated with `waitingDays`.
 */
export function findUnansweredIssues(issues, { now, graceHours }) {
  const nowMs = now.getTime();
  const graceMs = graceHours * 3600 * 1000;

  return issues
    .filter((issue) => isExternalIssue(issue) && !hasMaintainerReply(issue))
    .map((issue) => ({
      ...issue,
      waitedMs: nowMs - new Date(issue.createdAt).getTime(),
    }))
    .filter((issue) => issue.waitedMs > graceMs)
    .sort((a, b) => b.waitedMs - a.waitedMs)
    .map(({ waitedMs, ...issue }) => ({
      ...issue,
      waitingDays: Math.floor(waitedMs / MS_PER_DAY),
    }));
}

/**
 * Decodes the GraphQL payload into the flat shape the functions above expect.
 *
 * It throws rather than returning [] on anything unexpected — an auth failure
 * or a renamed field must fail the sweep loudly. Decoding a broken payload to
 * an empty list would report "nothing is waiting", which is the precise
 * silent-green this check exists to prevent.
 */
export function parseIssuesResponse(response) {
  if (response?.errors?.length) {
    throw new Error(
      `GitHub API returned errors: ${response.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const nodes = response?.data?.repository?.issues?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(
      "unexpected GitHub API response: data.repository.issues.nodes is not an array",
    );
  }

  return nodes.map((node) => ({
    number: node.number,
    title: node.title,
    url: node.url,
    createdAt: node.createdAt,
    authorLogin: node.author?.login ?? null,
    authorAssociation: node.authorAssociation,
    comments: (node.comments?.nodes ?? []).map((comment) => ({
      authorLogin: comment.author?.login ?? null,
      authorAssociation: comment.authorAssociation,
    })),
  }));
}

/**
 * Reads the cursor that says whether the tracker has more issues than this
 * page.
 *
 * Throws when `pageInfo` is absent rather than assuming a single page: the
 * repo had 151 open issues against a 100-item page when this was written, so
 * a query that quietly drops `pageInfo` would make the sweep read two thirds
 * of the tracker and call it all.
 */
export function parsePageInfo(response) {
  const pageInfo = response?.data?.repository?.issues?.pageInfo;
  if (!pageInfo) {
    throw new Error(
      "unexpected GitHub API response: issues.pageInfo is missing — the query must select it",
    );
  }
  return { hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor };
}

/**
 * Decodes an `issues` webhook payload into the same shape as
 * parseIssuesResponse, so the labelling job and the sweep classify through
 * one rule instead of two.
 *
 * The webhook and GraphQL disagree on spelling — `author_association` vs
 * `authorAssociation`, `user` vs `author`, `html_url` vs `url`. Reading the
 * wrong one yields `undefined`, which classifies as external and would label
 * every issue the team opens itself.
 */
export function parseIssueEvent(payload) {
  const issue = payload?.issue;
  if (!issue) {
    throw new Error("unexpected webhook payload: no `issue` object");
  }

  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    createdAt: issue.created_at,
    authorLogin: issue.user?.login ?? null,
    authorAssociation: issue.author_association,
    comments: [],
  };
}

/**
 * Issue titles and logins are text somebody else wrote. An unescaped `|`
 * splits a Markdown row into extra cells and pushes the link — the only
 * actionable column — out of view.
 */
function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|");
}

/** Renders the sweep's verdict for the GitHub Actions job summary. */
export function formatOverdueSummary(overdue) {
  if (overdue.length === 0) {
    return "✅ No external issues are waiting for a first reply.";
  }

  const lines = [
    `## ${overdue.length} external issue${overdue.length === 1 ? "" : "s"} waiting for a first reply`,
    "",
    "| Issue | Reporter | Waiting | Link |",
    "| --- | --- | --- | --- |",
  ];

  for (const issue of overdue) {
    const days = `${issue.waitingDays} day${issue.waitingDays === 1 ? "" : "s"}`;
    lines.push(
      `| #${issue.number} ${escapeCell(issue.title)} | @${escapeCell(issue.authorLogin)} | ${days} | ${issue.url} |`,
    );
  }

  return lines.join("\n");
}

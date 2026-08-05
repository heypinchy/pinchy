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

/**
 * True when this person may write to the repo.
 *
 * `authorAssociation` alone is not enough, and the reason is the whole point
 * of `annotateWriteAccess` below: the association GitHub reports is relative
 * to the ASKING TOKEN. An Actions `GITHUB_TOKEN` cannot see a private org
 * membership, so on 2026-08-05 it reported this repo's own admin as
 * CONTRIBUTOR on all 122 of his issues — and CONTRIBUTOR is external by
 * design. The sweep named 99 "waiting strangers", two of whom were real.
 *
 * So the association may only ever ADD team membership, never withhold it:
 * a token that can see more is believed, a token that sees less defers to
 * `authorHasWriteAccess`, which comes from the permission API and does not
 * depend on who is asking.
 */
function hasWriteAccess({ authorAssociation, authorHasWriteAccess }) {
  return (
    authorHasWriteAccess === true || TEAM_ASSOCIATIONS.has(authorAssociation)
  );
}

function isTeam(person) {
  return isBot(person.authorLogin) || hasWriteAccess(person);
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
    (comment) => !isBot(comment.authorLogin) && hasWriteAccess(comment),
  );
}

/**
 * Fills in `authorHasWriteAccess` for every author and commenter the
 * association cannot settle, by asking `resolveWriteAccess(login)`.
 *
 * Kept here, injected rather than imported, so the rule stays testable
 * without a network — but it lives beside the rule it feeds, because getting
 * it wrong is not a formatting bug: too few lookups and we are back to the
 * incident above, too many and one author costs 122 requests.
 *
 * Three things it deliberately does NOT ask about: a login the association
 * already settles, a bot, and `null` (a deleted account, where there is
 * nobody to ask about). A rejection propagates on purpose — see the note in
 * the resolver.
 */
export async function annotateWriteAccess(issues, resolveWriteAccess) {
  const answers = new Map();

  const annotate = async (person) => {
    const login = person.authorLogin;
    if (
      !login ||
      isBot(login) ||
      TEAM_ASSOCIATIONS.has(person.authorAssociation)
    ) {
      return person;
    }
    // The promise is cached, not the value: two people asking at once share
    // one request rather than racing to make a second.
    if (!answers.has(login)) answers.set(login, resolveWriteAccess(login));
    return { ...person, authorHasWriteAccess: await answers.get(login) };
  };

  const annotated = [];
  for (const issue of issues) {
    const comments = [];
    for (const comment of issue.comments ?? []) {
      comments.push(await annotate(comment));
    }
    annotated.push({ ...(await annotate(issue)), comments });
  }
  return annotated;
}

const MS_PER_DAY = 24 * 3600 * 1000;

/**
 * Every arithmetic input is validated up front, because NaN is this function's
 * silent-green path: `waited > NaN` is false for every issue, so one unusable
 * number would make the sweep announce that nothing is waiting and pass.
 *
 * The grace period arrives as a string from the workflow's env, where a typo
 * (`"48h"`) is a plausible mistake. An unparseable date means the query's
 * `createdAt` was renamed or came back null — the same class of decode failure
 * parseIssuesResponse throws on, and it must be just as loud here.
 */
function requirePositiveNumber(value, what) {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
    // `JSON.stringify(NaN)` is "null", which would hide the very thing the
    // reader needs — quote the value as given instead. This is why the caller
    // hands over the raw env string rather than a pre-`Number()`ed NaN.
    throw new Error(
      `${what} must be a positive finite number of hours, got ${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
    );
  }
  return number;
}

function createdAtMs(issue) {
  const ms = new Date(issue.createdAt ?? NaN).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(
      `issue #${issue.number} has no usable creation date: ${JSON.stringify(issue.createdAt)}`,
    );
  }
  return ms;
}

/**
 * Returns the external issues that have gone unanswered past the grace
 * period, longest wait first, each annotated with `waitingDays`.
 */
export function findUnansweredIssues(issues, { now, graceHours }) {
  const nowMs = now.getTime();
  const graceMs =
    requirePositiveNumber(graceHours, "the grace period") * 3600 * 1000;

  return issues
    .filter((issue) => isExternalIssue(issue) && !hasMaintainerReply(issue))
    .map((issue) => ({
      ...issue,
      waitedMs: nowMs - createdAtMs(issue),
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

  // The number goes straight into a request path, and the payload arrives from
  // a file on disk (GITHUB_EVENT_PATH). Pinning it to a positive integer is
  // what stops a malformed or tampered payload from steering that URL.
  if (!Number.isInteger(issue.number) || issue.number <= 0) {
    throw new Error(
      `unexpected webhook payload: issue number is not a positive integer`,
    );
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
 *
 * The backslash pass has to come first, and it is not cosmetic: escaping only
 * the pipe turns a title containing `\|` into `\\|`, which Markdown reads as a
 * literal backslash followed by a LIVE separator — worse than no escaping at
 * all. `structuralPipes` in the test counts what Markdown will actually treat
 * as a separator, so it fails on that shape rather than on the spelling.
 */
function escapeCell(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * GitHub returns `author: null` once an account is deleted, which
 * parseIssuesResponse keeps as null rather than inventing a name. Printing
 * "@null" would read like a username and send the reader hunting for a profile
 * that never existed.
 */
function reporter(authorLogin) {
  return authorLogin ? `@${escapeCell(authorLogin)}` : "(deleted account)";
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
      `| #${issue.number} ${escapeCell(issue.title)} | ${reporter(issue.authorLogin)} | ${days} | ${issue.url} |`,
    );
  }

  return lines.join("\n");
}

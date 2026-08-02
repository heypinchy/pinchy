/**
 * Sorts every open issue into one bucket of evidence, so a triage pass reads
 * the tracker once instead of opening 148 tabs.
 *
 * The split that matters is between this file and the skill that drives it:
 * **this file collects facts, it never reaches a verdict.** It will say that
 * #465 has a merged pull request in its timeline; it will not say that #465 is
 * done. That distinction is not pedantry — a sweep on 2026-08-01 found 54 of
 * 148 open issues carrying a merged cross-reference, and #543 and #669 were
 * among them while being perfectly legitimate open tracking issues. The
 * heuristic produces candidates. Deciding costs a human-or-agent read of the
 * PR and a grep against `origin/main`, and that lives in the skill.
 *
 * Staleness is deliberately absent. The obvious design — close what nobody
 * touched in 90 days — was measured against this tracker and found 16 issues
 * out of 148. The backlog here is not abandoned, it is unresolved, and a
 * signal that weak would spend the trust the sweep needs.
 */

import { isExternalIssue, hasMaintainerReply } from "./issue-triage.mjs";

/**
 * Buckets in priority order: an issue lands in the first one it matches.
 *
 * Ordering is what keeps the strongest evidence visible. An issue is very
 * often unlabeled AND solved by a merged PR, and reporting it as merely
 * unlabeled would bury the one fact that decides its fate.
 */
export const BUCKET_ORDER = [
  "in-flight",
  "closed-by-pr",
  "subsumed",
  "untriaged",
  "no-discussion",
  "active",
];

export const BUCKET_DESCRIPTIONS = {
  "in-flight": "an OPEN PR is against this issue — somebody is building it now",
  "closed-by-pr": "a merged PR references this issue — verify, then close",
  subsumed: "an open tracking issue covers this — verify, then fold in",
  untriaged: "nobody has categorised this yet",
  "no-discussion": "an enhancement nobody has ever commented on",
  active: "categorised, discussed, no merge evidence — leave alone",
};

/**
 * Labels that record a process state rather than a human's judgement.
 *
 * `issue-triage.yml` stamps both onto an external report the moment it lands,
 * before anyone has read a word of it. Counting them as "categorised" would
 * make every incoming report look triaged by its own arrival — and the weekly
 * pass filters on exactly this, so the bug would be invisible: a clean queue
 * that quietly excludes the issues that most need a look.
 */
const PROCESS_LABELS = new Set(["triage", "external"]);

/**
 * Titles that mark an issue as an umbrella rather than a peer.
 *
 * Narrow on purpose. Issues cross-reference each other constantly ("related to
 * #x"), so treating every reference as subsumption would sweep the whole
 * tracker into one bucket and say nothing. These three words are how the
 * umbrellas in this repo actually name themselves — #543 is
 * "RFC/Tracking: Pinchy Skill Layer (consolidates #354/#126/#37…)".
 */
const TRACKING_TITLE = /\btracking\b|\brfc\b|consolidat/i;

function bucketFor(issue) {
  const categoryLabels = issue.labels.filter((l) => !PROCESS_LABELS.has(l));

  // Ranked above merge evidence, and that ordering was paid for. The first
  // full sweep closed #128, #333 and #829 under the no-standing-backlog rule
  // while an open PR sat against each one — invisible, because the sweep read
  // merged pull requests only. An open PR is the strongest possible answer to
  // "is anyone going to build this", and an issue that has BOTH a merged and
  // an open PR is a live follow-up, not a completed one.
  if (issue.openPrs.length > 0) return "in-flight";
  if (issue.mergedPrs.length > 0) return "closed-by-pr";
  if (issue.trackedBy.length > 0) return "subsumed";
  if (categoryLabels.length === 0) return "untriaged";
  if (categoryLabels.includes("enhancement") && issue.comments.length === 0) {
    return "no-discussion";
  }
  return "active";
}

/**
 * Classifies one issue into a bucket plus two orthogonal flags.
 *
 * Neither is a bucket, and that is the load-bearing choice here.
 *
 * `externalWaiting`: making it exclusive would hide the merge evidence on
 * precisely the issues where an outside reporter is owed an answer.
 * `unanswered-sweep` goes red until a maintainer comments, and only a
 * maintainer comment clears it — so the triage pass must be able to see "this
 * is solved" and "do not comment here" at the same time.
 *
 * `neverDiscussed`: the buckets are exclusive, and `untriaged` outranks
 * `no-discussion`, so an unlabeled enhancement nobody ever commented on is
 * only ever reported as untriaged. Labelling it — which is exactly what a pass
 * does to satisfy the invariant — moves it into `no-discussion`, where the
 * next report offers it up as a fresh default-close candidate. The first full
 * sweep did that to 19 issues in one afternoon. The flag makes the fact
 * visible in the bucket where it can still be acted on.
 *
 * See the skill for what these two mean for the pass.
 */
export function classifyIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    bucket: bucketFor(issue),
    externalWaiting: isExternalIssue(issue) && !hasMaintainerReply(issue),
    neverDiscussed: issue.comments.length === 0,
    evidence: {
      openPrs: issue.openPrs,
      mergedPrs: issue.mergedPrs,
      trackedBy: issue.trackedBy,
      labels: issue.labels,
      comments: issue.comments.length,
    },
  };
}

/** Classifies every issue, strongest evidence first. */
export function classifyIssues(issues) {
  return issues
    .map(classifyIssue)
    .sort(
      (a, b) =>
        BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
        a.number - b.number,
    );
}

/**
 * Decodes the GraphQL payload into the flat shape above.
 *
 * It throws on anything it cannot read, for the same reason
 * parseIssuesResponse does: decoding a broken payload to an empty list would
 * report a clean tracker, and "nothing to triage" is exactly the silent green
 * a triage tool must never produce. An expired token is the likely cause and
 * it must stop the pass, not shorten it.
 */
function requireComplete(issueNumber, what, connection) {
  const fetched = connection?.nodes?.length ?? 0;
  const total = connection?.totalCount;

  // The guard's own silent-green path, and the reason this is a hard
  // requirement rather than a `typeof total === "number" &&` guard: without
  // the count, `fetched < undefined` is false for every issue, so a query that
  // stopped selecting `totalCount` for one connection would switch that list's
  // truncation check off and change nothing visible. Requiring it fails on the
  // first real sweep, one line into the output.
  if (typeof total !== "number") {
    throw new Error(
      `issue #${issueNumber}: the query must select totalCount for ${what} — ` +
        `without it a truncated list is indistinguishable from a complete one`,
    );
  }

  if (fetched < total) {
    throw new Error(
      `issue #${issueNumber}: read ${fetched} of ${total} ${what} — raise the page size in SWEEP_QUERY, ` +
        `a truncated list would classify this issue on partial evidence`,
    );
  }
}

export function parseSweepResponse(response) {
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

  // Same reasoning as parsePageInfo in issue-triage.mjs: this tracker holds
  // more issues than one page, so a query that quietly drops the cursor would
  // read part of the backlog and present it as all of it.
  if (!response.data.repository.issues.pageInfo) {
    throw new Error(
      "unexpected GitHub API response: issues.pageInfo is missing — the query must select it",
    );
  }

  return nodes.map((node) => {
    // A clipped nested list is this parser's subtlest wrong answer, and it
    // never looks like an error: 51 comments with the maintainer's reply at
    // #51 turns an answered report into "external, unanswered", a clipped
    // timeline drops the merge evidence that decides the whole closed-by-pr
    // bucket, and a clipped label list drops the `enhancement` that separates
    // an untriaged issue from a triaged one. All three are one number in
    // SWEEP_QUERY, so failing loudly costs a one-word edit and buying silence
    // costs a wrong triage pass.
    requireComplete(node.number, "labels", node.labels);
    requireComplete(node.number, "comments", node.comments);
    requireComplete(node.number, "cross-references", node.timelineItems);

    const sources = (node.timelineItems?.nodes ?? [])
      .map((item) => item.source)
      .filter(Boolean);

    return {
      number: node.number,
      title: node.title,
      url: node.url,
      createdAt: node.createdAt,
      authorLogin: node.author?.login ?? null,
      authorAssociation: node.authorAssociation,
      labels: (node.labels?.nodes ?? []).map((label) => label.name),
      comments: (node.comments?.nodes ?? []).map((comment) => ({
        authorLogin: comment.author?.login ?? null,
        authorAssociation: comment.authorAssociation,
      })),
      // Work in flight. `state === "OPEN"` rather than `!merged`: a pull
      // request CLOSED without merging is abandoned, and reading it as
      // in-flight would keep an issue alive on the strength of work somebody
      // already gave up on — the mirror of the merged-vs-closed mistake below.
      openPrs: sources
        .filter((s) => s.__typename === "PullRequest" && s.state === "OPEN")
        .map((s) => s.number),
      // `merged` rather than "there was a PR": a pull request closed without
      // merging is evidence of nothing, and counting it would recommend
      // closing an issue whose fix was abandoned.
      mergedPrs: sources
        .filter((s) => s.__typename === "PullRequest" && s.merged === true)
        .map((s) => s.number),
      trackedBy: sources
        .filter(
          (s) =>
            s.__typename === "Issue" &&
            s.state === "OPEN" &&
            TRACKING_TITLE.test(s.title ?? ""),
        )
        .map((s) => s.number),
    };
  });
}

/**
 * The GraphQL query the sweep runs.
 *
 * Exported because every other test in this file runs against a fixture, so
 * all of them stay green if this query stops selecting a field the parser
 * reads — and the resulting empty bucket looks exactly like a clean tracker.
 * `the query selects every field the parser reads` is what makes that edit
 * fail instead of pass.
 */
export const SWEEP_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url createdAt authorAssociation
        author { login }
        labels(first: 20) { totalCount nodes { name } }
        comments(first: 100) { totalCount nodes { authorAssociation author { login } } }
        timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
          totalCount
          nodes {
            ... on CrossReferencedEvent {
              source {
                __typename
                ... on PullRequest { number merged state }
                ... on Issue { number title state }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Flattens a title onto one line.
 *
 * Titles are text somebody outside the team wrote, and this report is read by
 * an agent that then closes issues on its say-so. A newline would forge report
 * structure — an extra list item, or a whole fake bucket heading — so the
 * title has to stay inside the line it was given. `escapeCell` in
 * issue-triage.mjs guards the same data for the same reason; it escapes `|`
 * because it builds a table, which a list item does not need.
 */
function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function line(entry) {
  const facts = [];
  if (entry.evidence.openPrs.length) {
    facts.push(
      `open PR ${entry.evidence.openPrs.map((n) => `#${n}`).join(", ")}`,
    );
  }
  if (entry.evidence.mergedPrs.length) {
    facts.push(
      `merged: ${entry.evidence.mergedPrs.map((n) => `#${n}`).join(", ")}`,
    );
  }
  if (entry.evidence.trackedBy.length) {
    facts.push(
      `tracked by ${entry.evidence.trackedBy.map((n) => `#${n}`).join(", ")}`,
    );
  }
  const flags = [];
  if (entry.externalWaiting) flags.push("⚠ external, unanswered");
  // Only worth printing where the bucket does not already say it: the whole
  // no-discussion bucket is comment-less by definition, and repeating it on
  // every line there would train the reader to skip the marker.
  if (entry.neverDiscussed && entry.bucket !== "no-discussion") {
    flags.push("never discussed");
  }
  const detail = facts.length ? ` — ${facts.join("; ")}` : "";
  const flag = flags.length ? ` [${flags.join("; ")}]` : "";
  return `- #${entry.number} ${oneLine(entry.title)}${detail}${flag}`;
}

/**
 * Renders the sweep as markdown for the skill to read.
 *
 * Protected issues get their own section at the top rather than only an inline
 * marker: the rule they carry is a prohibition, and a prohibition buried on
 * line 90 of a 149-line report is one nobody applies.
 */
export function formatSweepReport(entries) {
  const out = [`# Triage sweep — ${entries.length} open issues`, ""];

  const protectedEntries = entries.filter((e) => e.externalWaiting);
  if (protectedEntries.length) {
    out.push(
      `## ⚠ Protected: ${protectedEntries.length} external report(s) awaiting a maintainer reply`,
      "",
      "Do NOT comment on these. Only a maintainer comment clears the",
      "`unanswered-sweep` alarm, so an automated reply would silence it without",
      "anyone having answered. Closing with a reason is the honest alternative,",
      "and needs explicit approval.",
      "",
      ...protectedEntries.map(line),
      "",
    );
  }

  for (const bucket of BUCKET_ORDER) {
    const inBucket = entries.filter((e) => e.bucket === bucket);
    if (!inBucket.length) continue;
    out.push(
      `## ${bucket} (${inBucket.length}) — ${BUCKET_DESCRIPTIONS[bucket]}`,
      "",
      ...inBucket.map(line),
      "",
    );
  }

  return out.join("\n");
}

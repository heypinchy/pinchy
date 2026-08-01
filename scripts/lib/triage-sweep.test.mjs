import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUCKET_ORDER,
  SWEEP_QUERY,
  classifyIssue,
  classifyIssues,
  parseSweepResponse,
  formatSweepReport,
} from "./triage-sweep.mjs";

function issue(overrides = {}) {
  return {
    number: 1,
    title: "Something",
    url: "https://github.com/heypinchy/pinchy/issues/1",
    createdAt: "2026-01-01T00:00:00Z",
    authorLogin: "clemenshelm",
    authorAssociation: "OWNER",
    labels: ["enhancement"],
    comments: [{ authorLogin: "clemenshelm", authorAssociation: "OWNER" }],
    mergedPrs: [],
    trackedBy: [],
    ...overrides,
  };
}

test("an issue with a merged cross-referenced PR is a closed-by-pr candidate", () => {
  const entry = classifyIssue(issue({ mergedPrs: [872, 979] }));

  assert.equal(entry.bucket, "closed-by-pr");
  assert.deepEqual(entry.evidence.mergedPrs, [872, 979]);
});

test("an issue referenced by an open tracking issue is subsumed", () => {
  const entry = classifyIssue(issue({ trackedBy: [543] }));

  assert.equal(entry.bucket, "subsumed");
  assert.deepEqual(entry.evidence.trackedBy, [543]);
});

test("an issue carrying no labels at all is untriaged", () => {
  const entry = classifyIssue(issue({ labels: [] }));

  assert.equal(entry.bucket, "untriaged");
});

// The weekly pass filters on "nobody has looked at this yet". `triage` and
// `external` are set by the issue-triage workflow the moment a report lands,
// so treating them as evidence of a look would hide every incoming report
// behind a label the reporter's own arrival created.
test("process labels are not evidence that anyone looked", () => {
  const entry = classifyIssue(issue({ labels: ["triage", "external"] }));

  assert.equal(entry.bucket, "untriaged");
});

test("any category label means the issue was triaged", () => {
  for (const label of ["bug", "enhancement", "priority:P1", "wontfix"]) {
    const entry = classifyIssue(
      issue({
        labels: [label, "triage"],
        comments: [{ authorLogin: "x", authorAssociation: "OWNER" }],
      }),
    );
    assert.notEqual(entry.bucket, "untriaged", `${label} should count`);
  }
});

test("an enhancement nobody ever commented on is no-discussion", () => {
  const entry = classifyIssue(issue({ labels: ["enhancement"], comments: [] }));

  assert.equal(entry.bucket, "no-discussion");
});

test("a labelled, discussed issue with no merge evidence is active", () => {
  assert.equal(classifyIssue(issue({ labels: ["bug"] })).bucket, "active");
});

// The whole point of the sweep is that the strongest evidence wins. An issue
// can easily be unlabeled AND solved by a merged PR — reporting it as merely
// unlabeled would bury the one fact that decides its fate.
test("merge evidence outranks every weaker signal", () => {
  const entry = classifyIssue(
    issue({ labels: [], comments: [], mergedPrs: [42], trackedBy: [543] }),
  );

  assert.equal(entry.bucket, "closed-by-pr");
});

// external-waiting is a flag, not a bucket, and that is deliberate. Making it
// exclusive would hide the merge evidence on exactly the issues where an
// outside reporter is owed an answer — the ones we most need to get right.
test("an unanswered outside report is flagged without losing its bucket", () => {
  const entry = classifyIssue(
    issue({
      authorLogin: "stranger",
      authorAssociation: "NONE",
      comments: [],
      labels: ["bug"],
      mergedPrs: [900],
    }),
  );

  assert.equal(entry.externalWaiting, true);
  assert.equal(entry.bucket, "closed-by-pr");
});

test("an outside report a maintainer already answered is not waiting", () => {
  const entry = classifyIssue(
    issue({
      authorLogin: "stranger",
      authorAssociation: "NONE",
      comments: [{ authorLogin: "clemenshelm", authorAssociation: "OWNER" }],
    }),
  );

  assert.equal(entry.externalWaiting, false);
});

test("classifyIssues returns entries ordered by bucket priority", () => {
  const entries = classifyIssues([
    issue({ number: 3, labels: ["bug"] }),
    issue({ number: 1, mergedPrs: [10] }),
    issue({ number: 2, labels: [] }),
  ]);

  const buckets = entries.map((e) => e.bucket);
  const positions = buckets.map((b) => BUCKET_ORDER.indexOf(b));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  assert.equal(entries[0].number, 1);
});

test("parseSweepResponse flattens the GraphQL payload", () => {
  const issues = parseSweepResponse({
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 7,
              title: "Wire it up",
              url: "https://example.invalid/7",
              createdAt: "2026-01-01T00:00:00Z",
              author: { login: "stranger" },
              authorAssociation: "NONE",
              labels: { nodes: [{ name: "bug" }] },
              comments: {
                nodes: [
                  { author: { login: "bot[bot]" }, authorAssociation: "NONE" },
                ],
              },
              timelineItems: {
                nodes: [
                  {
                    source: {
                      __typename: "PullRequest",
                      number: 8,
                      merged: true,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].labels, ["bug"]);
  assert.deepEqual(issues[0].mergedPrs, [8]);
  assert.equal(issues[0].authorLogin, "stranger");
  assert.equal(issues[0].comments.length, 1);
});

// The dangerous decode error. A PR that was closed without ever merging is
// evidence of nothing, and counting it would recommend closing an issue whose
// fix was abandoned.
test("only merged pull requests count as merge evidence", () => {
  const issues = parseSweepResponse(
    responseWithTimeline([
      { __typename: "PullRequest", number: 8, merged: false },
      { __typename: "PullRequest", number: 9, merged: true },
    ]),
  );

  assert.deepEqual(issues[0].mergedPrs, [9]);
});

test("only OPEN tracking issues subsume another issue", () => {
  const issues = parseSweepResponse(
    responseWithTimeline([
      {
        __typename: "Issue",
        number: 543,
        title: "Tracking: Skill Layer",
        state: "OPEN",
      },
      {
        __typename: "Issue",
        number: 100,
        title: "Tracking: done long ago",
        state: "CLOSED",
      },
      {
        __typename: "Issue",
        number: 200,
        title: "Some ordinary issue",
        state: "OPEN",
      },
    ]),
  );

  assert.deepEqual(issues[0].trackedBy, [543]);
});

// Same discipline as parseIssuesResponse: a decode failure must be loud.
// Returning [] here would report an empty tracker, which reads as "nothing to
// triage" — the silent green this sweep exists to prevent.
test("parseSweepResponse throws on a payload it cannot read", () => {
  assert.throws(
    () => parseSweepResponse({ data: { repository: {} } }),
    /nodes/,
  );
  assert.throws(
    () => parseSweepResponse({ errors: [{ message: "Bad credentials" }] }),
    /Bad credentials/,
  );
});

test("parseSweepResponse throws when the query drops pageInfo", () => {
  const response = responseWithTimeline([]);
  delete response.data.repository.issues.pageInfo;

  assert.throws(() => parseSweepResponse(response), /pageInfo/);
});

test("the report names the protected issues explicitly", () => {
  const report = formatSweepReport(
    classifyIssues([
      issue({
        number: 42,
        authorLogin: "stranger",
        authorAssociation: "NONE",
        comments: [],
        labels: ["bug"],
      }),
    ]),
  );

  assert.match(report, /#42/);
  assert.match(report, /external/i);
});

// Every test above runs against a fixture, so all of them stay green if the
// real query stops selecting a field the parser reads. That is not a
// hypothetical: drop `merged` and mergedPrs is empty for every issue, the
// closed-by-pr bucket reads as zero, and an empty bucket looks exactly like a
// clean tracker. These two tests are the only thing standing between a
// one-word edit and a sweep that silently finds nothing.
test("the query selects every field the parser reads", () => {
  for (const field of [
    "merged", // → mergedPrs, the whole closed-by-pr bucket
    "state", // → trackedBy, open-tracking-issue check
    "__typename", // → tells a PR source from an Issue source
    "authorAssociation", // → externalWaiting
    "pageInfo", // → pagination; without it the sweep reads one page
    "totalCount", // → the truncation check below
  ]) {
    assert.match(
      SWEEP_QUERY,
      new RegExp(`\\b${field}\\b`),
      `SWEEP_QUERY must select ${field}`,
    );
  }
});

// A page-size cap is a silent lie of the same family: 51 comments and the
// maintainer reply sitting at #51 makes an answered report look unanswered,
// while a clipped timeline hides merge evidence. Loud beats subtly wrong —
// the fix is one number in the query, and the message says so.
test("parseSweepResponse throws when a nested list was truncated", () => {
  const clipped = responseWithTimeline([]);
  clipped.data.repository.issues.nodes[0].comments.totalCount = 80;

  assert.throws(() => parseSweepResponse(clipped), /#7.*80 comments/s);

  const clippedTimeline = responseWithTimeline([]);
  clippedTimeline.data.repository.issues.nodes[0].timelineItems.totalCount = 60;

  assert.throws(() => parseSweepResponse(clippedTimeline), /#7.*cross-ref/s);
});

function responseWithTimeline(timelineNodes) {
  return {
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 7,
              title: "Wire it up",
              url: "https://example.invalid/7",
              createdAt: "2026-01-01T00:00:00Z",
              author: { login: "clemenshelm" },
              authorAssociation: "OWNER",
              labels: { nodes: [] },
              comments: { nodes: [], totalCount: 0 },
              timelineItems: {
                nodes: timelineNodes.map((source) => ({ source })),
                totalCount: timelineNodes.length,
              },
            },
          ],
        },
      },
    },
  };
}

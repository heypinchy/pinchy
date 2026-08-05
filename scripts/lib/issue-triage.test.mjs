import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  TEAM_ASSOCIATIONS,
  annotateWriteAccess,
  isExternalIssue,
  hasMaintainerReply,
  findUnansweredIssues,
  formatOverdueSummary,
  parseIssuesResponse,
  parseIssueEvent,
  parsePageInfo,
} from "./issue-triage.mjs";

const NOW = new Date("2026-07-28T09:00:00Z");

function hoursAgo(h) {
  return new Date(NOW.getTime() - h * 3600 * 1000).toISOString();
}

function issue(overrides = {}) {
  return {
    number: 1,
    title: "Something broke",
    url: "https://github.com/heypinchy/pinchy/issues/1",
    createdAt: hoursAgo(72),
    authorLogin: "outsider",
    authorAssociation: "NONE",
    comments: [],
    ...overrides,
  };
}

test("the team associations are exactly GitHub's write-access set", () => {
  assert.deepEqual([...TEAM_ASSOCIATIONS].sort(), [
    "COLLABORATOR",
    "MEMBER",
    "OWNER",
  ]);
});

test("isExternalIssue treats a drive-by reporter as external", () => {
  assert.equal(isExternalIssue(issue({ authorAssociation: "NONE" })), true);
});

test("isExternalIssue treats a past contributor as external", () => {
  // CONTRIBUTOR only means "had a PR merged once". Such a report still needs a
  // maintainer answer, so it must not fall out of the sweep.
  assert.equal(
    isExternalIssue(issue({ authorAssociation: "CONTRIBUTOR" })),
    true,
  );
  assert.equal(
    isExternalIssue(issue({ authorAssociation: "FIRST_TIME_CONTRIBUTOR" })),
    true,
  );
});

test("isExternalIssue does not flag the team's own issues", () => {
  for (const association of TEAM_ASSOCIATIONS) {
    assert.equal(
      isExternalIssue(issue({ authorAssociation: association })),
      false,
    );
  }
});

test("isExternalIssue does not flag issues opened by a bot", () => {
  // Automation files issues under a bot identity with no team association.
  // Counting those as "an outsider is waiting" would leave the sweep
  // permanently red for reports no human is waiting on.
  assert.equal(
    isExternalIssue(
      issue({ authorLogin: "github-actions[bot]", authorAssociation: "NONE" }),
    ),
    false,
  );
});

test("isExternalIssue believes write access over the association", () => {
  // The 2026-08-05 incident: the Actions token cannot see a private org
  // membership, so it reports the repo's own admin as CONTRIBUTOR. The
  // association is a claim about what the ASKING TOKEN may see; the
  // permission lookup is a fact about the repo.
  assert.equal(
    isExternalIssue(
      issue({
        authorLogin: "clemenshelm",
        authorAssociation: "CONTRIBUTOR",
        authorHasWriteAccess: true,
      }),
    ),
    false,
  );
});

test("isExternalIssue keeps a past contributor without write access external", () => {
  // The other direction, and the one the CONTRIBUTOR rule exists for: a
  // merged PR is not team membership.
  assert.equal(
    isExternalIssue(
      issue({
        authorAssociation: "CONTRIBUTOR",
        authorHasWriteAccess: false,
      }),
    ),
    true,
  );
});

test("hasMaintainerReply sees a comment from the team", () => {
  assert.equal(
    hasMaintainerReply(
      issue({
        comments: [{ authorLogin: "clemenshelm", authorAssociation: "OWNER" }],
      }),
    ),
    true,
  );
});

test("hasMaintainerReply ignores a reply from another outsider", () => {
  // "Me too" from a second user is not an answer — the reporter is still
  // waiting on us.
  assert.equal(
    hasMaintainerReply(
      issue({
        comments: [{ authorLogin: "someone-else", authorAssociation: "NONE" }],
      }),
    ),
    false,
  );
});

test("hasMaintainerReply believes write access over the association", () => {
  // Same downgrade, read from the other end: every reply we have ever written
  // arrives as CONTRIBUTOR too, so without this the sweep counts an answered
  // issue as unanswered.
  assert.equal(
    hasMaintainerReply(
      issue({
        comments: [
          {
            authorLogin: "clemenshelm",
            authorAssociation: "CONTRIBUTOR",
            authorHasWriteAccess: true,
          },
        ],
      }),
    ),
    true,
  );
});

test("hasMaintainerReply ignores the reporter's own follow-up", () => {
  assert.equal(
    hasMaintainerReply(
      issue({
        authorLogin: "outsider",
        comments: [{ authorLogin: "outsider", authorAssociation: "NONE" }],
      }),
    ),
    false,
  );
});

test("findUnansweredIssues reports an old external issue nobody answered", () => {
  const overdue = findUnansweredIssues([issue()], { now: NOW, graceHours: 48 });
  assert.deepEqual(
    overdue.map((i) => i.number),
    [1],
  );
});

test("findUnansweredIssues stays quiet inside the grace period", () => {
  const overdue = findUnansweredIssues([issue({ createdAt: hoursAgo(12) })], {
    now: NOW,
    graceHours: 48,
  });
  assert.deepEqual(overdue, []);
});

test("findUnansweredIssues stops reporting once a maintainer replies", () => {
  const overdue = findUnansweredIssues(
    [
      issue({
        comments: [{ authorLogin: "clemenshelm", authorAssociation: "MEMBER" }],
      }),
    ],
    { now: NOW, graceHours: 48 },
  );
  assert.deepEqual(overdue, []);
});

test("findUnansweredIssues ignores our own issues however old", () => {
  const overdue = findUnansweredIssues(
    [issue({ authorAssociation: "OWNER", createdAt: hoursAgo(2000) })],
    { now: NOW, graceHours: 48 },
  );
  assert.deepEqual(overdue, []);
});

test("findUnansweredIssues puts the longest-waiting reporter first", () => {
  const overdue = findUnansweredIssues(
    [
      issue({ number: 10, createdAt: hoursAgo(50) }),
      issue({ number: 11, createdAt: hoursAgo(500) }),
      issue({ number: 12, createdAt: hoursAgo(72) }),
    ],
    { now: NOW, graceHours: 48 },
  );
  assert.deepEqual(
    overdue.map((i) => i.number),
    [11, 12, 10],
  );
});

test("findUnansweredIssues refuses a grace period that is not a real number", () => {
  // The grace period arrives as a string from the workflow's env. `Number()`
  // turns a typo into NaN, and every `waited > NaN` comparison is false — so
  // the sweep would announce "nothing is waiting" and pass. One mistyped
  // character in the workflow would disable the whole check without a trace,
  // which is the exact failure mode this check exists to prevent.
  for (const graceHours of [NaN, "48h", "", undefined, null, -1, Infinity]) {
    assert.throws(
      () => findUnansweredIssues([issue()], { now: NOW, graceHours }),
      /grace/i,
      `expected a throw for graceHours=${String(graceHours)}`,
    );
  }
});

test("the grace-period error quotes the value as it was written", () => {
  // A NaN stringifies to "null", so a message built from the converted number
  // hides the typo it is reporting. Naming "48h" is the whole point of failing.
  assert.throws(
    () => findUnansweredIssues([issue()], { now: NOW, graceHours: "48h" }),
    /"48h"/,
  );
});

test("findUnansweredIssues refuses an issue whose creation date does not parse", () => {
  // A renamed or missing `createdAt` makes `new Date(...)` invalid, and the
  // NaN comparison that follows drops the issue from the result — the reporter
  // vanishes from a sweep that still reports success. parseIssuesResponse
  // checks the payload's SHAPE; a null in a field of the right name passes it.
  for (const createdAt of [undefined, null, "", "not-a-date"]) {
    assert.throws(
      () =>
        findUnansweredIssues([issue({ createdAt })], {
          now: NOW,
          graceHours: 48,
        }),
      /creation date/i,
      `expected a throw for createdAt=${String(createdAt)}`,
    );
  }
});

test("findUnansweredIssues annotates how long the reporter has waited", () => {
  const [overdue] = findUnansweredIssues([issue({ createdAt: hoursAgo(72) })], {
    now: NOW,
    graceHours: 48,
  });
  assert.equal(overdue.waitingDays, 3);
});

test("issue #849 is exactly the shape this sweep exists to catch", () => {
  // The real record: an outside reporter, no labels, no comments, a week old.
  const overdue = findUnansweredIssues(
    [
      issue({
        number: 849,
        title: "Error: Setup failed",
        url: "https://github.com/heypinchy/pinchy/issues/849",
        createdAt: "2026-07-21T10:54:16Z",
        authorLogin: "Flindor",
        authorAssociation: "NONE",
        comments: [],
      }),
    ],
    { now: NOW, graceHours: 48 },
  );
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].number, 849);
});

test("the 2026-08-05 incident: our own tracker read as 99 waiting strangers", async () => {
  // What the scheduled sweep actually reported, in miniature. Every issue in
  // this repo is opened by the admin, whom the Actions token sees as
  // CONTRIBUTOR — so the alarm named 99 issues and drowned the two real ones.
  // An alarm that is always red is the state before #849, with more noise.
  const ours = issue({
    number: 124,
    authorLogin: "clemenshelm",
    authorAssociation: "CONTRIBUTOR",
    createdAt: hoursAgo(24 * 113),
  });
  const theirs = issue({
    number: 849,
    authorLogin: "Flindor",
    authorAssociation: "NONE",
  });

  const annotated = await annotateWriteAccess(
    [ours, theirs],
    async (login) => login === "clemenshelm",
  );
  const overdue = findUnansweredIssues(annotated, { now: NOW, graceHours: 48 });

  assert.deepEqual(
    overdue.map((i) => i.number),
    [849],
  );
});

test("annotateWriteAccess asks about each login once, however many issues", async () => {
  // 122 issues, one author: the lookup is per person, not per row. A resolver
  // called once per issue would spend 122 requests to learn one fact.
  const asked = [];
  await annotateWriteAccess(
    [
      issue({ number: 1, authorLogin: "clemenshelm" }),
      issue({ number: 2, authorLogin: "clemenshelm" }),
      issue({
        number: 3,
        authorLogin: "outsider",
        comments: [{ authorLogin: "clemenshelm", authorAssociation: "NONE" }],
      }),
    ],
    async (login) => {
      asked.push(login);
      return login === "clemenshelm";
    },
  );

  assert.deepEqual(asked.sort(), ["clemenshelm", "outsider"]);
});

test("annotateWriteAccess spends no request on someone the association settles", async () => {
  // A token that CAN see the membership says MEMBER, and a bot needs no
  // lookup at all. Neither is worth a round trip.
  const asked = [];
  await annotateWriteAccess(
    [
      issue({ authorLogin: "clemenshelm", authorAssociation: "OWNER" }),
      issue({ authorLogin: "dependabot[bot]", authorAssociation: "NONE" }),
    ],
    async (login) => {
      asked.push(login);
      return false;
    },
  );

  assert.deepEqual(asked, []);
});

test("annotateWriteAccess annotates comment authors too, not just reporters", async () => {
  const [annotated] = await annotateWriteAccess(
    [
      issue({
        authorLogin: "outsider",
        comments: [
          { authorLogin: "clemenshelm", authorAssociation: "CONTRIBUTOR" },
        ],
      }),
    ],
    async (login) => login === "clemenshelm",
  );

  assert.equal(hasMaintainerReply(annotated), true);
});

test("annotateWriteAccess leaves a deleted author alone instead of asking about null", async () => {
  const asked = [];
  const [annotated] = await annotateWriteAccess(
    [issue({ authorLogin: null, authorAssociation: "NONE" })],
    async (login) => {
      asked.push(login);
      return true;
    },
  );

  assert.deepEqual(asked, []);
  assert.equal(isExternalIssue(annotated), true);
});

test("annotateWriteAccess lets a failed lookup fail the sweep", async () => {
  // The one thing this must not do is decide "external" because it could not
  // ask. That is how a permissions change would quietly reproduce the very
  // incident this fixes — 99 names, all wrong, and nobody reading them.
  await assert.rejects(
    annotateWriteAccess([issue({ authorLogin: "clemenshelm" })], async () => {
      throw new Error("HTTP 403");
    }),
    /403/,
  );
});

test("formatOverdueSummary names each issue, its age and its link", () => {
  const summary = formatOverdueSummary([
    {
      number: 849,
      title: "Error: Setup failed",
      url: "https://github.com/heypinchy/pinchy/issues/849",
      authorLogin: "Flindor",
      waitingDays: 7,
    },
  ]);
  assert.match(summary, /849/);
  assert.match(summary, /Error: Setup failed/);
  assert.match(summary, /Flindor/);
  assert.match(summary, /7/);

  // Compare the link CELL for equality rather than searching the whole
  // summary for the URL. Both a regex and an `includes` over a URL are
  // "does this string appear somewhere" checks, which CodeQL flags
  // (missing-regexp-anchor / incomplete-url-substring-sanitization) — and it
  // has a point even in a test: this now asserts the link is in the column a
  // reader will click, not merely present in the text.
  const row = summary.split("\n").find((line) => line.includes("#849"));
  const cells = row.split("|").map((cell) => cell.trim());
  assert.equal(cells[4], "https://github.com/heypinchy/pinchy/issues/849");
});

test("formatOverdueSummary names a deleted account instead of printing @null", () => {
  // GitHub returns `author: null` once the account is gone — parseIssuesResponse
  // decodes that to null on purpose. Rendering it as "@null" reads like a
  // username and sends the reader looking for a profile that never existed.
  const summary = formatOverdueSummary([
    {
      number: 7,
      title: "Ghost report",
      url: "https://example.test/7",
      authorLogin: null,
      waitingDays: 9,
    },
  ]);
  assert.doesNotMatch(summary, /@null/);
  assert.match(summary, /deleted account/i);
});

test("formatOverdueSummary says so plainly when nothing is waiting", () => {
  const summary = formatOverdueSummary([]);
  assert.match(summary, /no external issues/i);
});

test("formatOverdueSummary keeps a pipe in the title from breaking the table", () => {
  // Issue titles are attacker-controlled text. A bare `|` splits the row into
  // extra cells and the reader loses the link column — the one thing they
  // need to act on.
  const summary = formatOverdueSummary([
    {
      number: 1,
      title: "Crash | on save",
      url: "https://example.test/1",
      authorLogin: "outsider",
      waitingDays: 2,
    },
  ]);
  const row = summary.split("\n").find((line) => line.includes("Crash"));
  // Four columns. An unescaped pipe would make it five and shift every value
  // one cell to the left.
  assert.equal(
    row.split(" | ").length,
    4,
    `row split into extra cells: ${row}`,
  );
  assert.match(row, /Crash \\\| on save/);
});

// The parser is where a silent green would come from: rename a field in the
// query and every issue decodes to `undefined`, which reads as "nothing is
// waiting". These pin the decode to a real GraphQL payload shape.
const GRAPHQL_RESPONSE = {
  data: {
    repository: {
      issues: {
        nodes: [
          {
            number: 849,
            title: "Error: Setup failed",
            url: "https://github.com/heypinchy/pinchy/issues/849",
            createdAt: "2026-07-21T10:54:16Z",
            authorAssociation: "NONE",
            author: { login: "Flindor" },
            comments: { nodes: [] },
          },
          {
            number: 848,
            title: "Internal cleanup",
            url: "https://github.com/heypinchy/pinchy/issues/848",
            createdAt: "2026-07-20T08:00:00Z",
            authorAssociation: "OWNER",
            author: { login: "clemenshelm" },
            comments: {
              nodes: [
                {
                  authorAssociation: "OWNER",
                  author: { login: "clemenshelm" },
                },
              ],
            },
          },
        ],
      },
    },
  },
};

test("parseIssuesResponse decodes issues into the shape the sweep works on", () => {
  const [first, second] = parseIssuesResponse(GRAPHQL_RESPONSE);

  assert.deepEqual(first, {
    number: 849,
    title: "Error: Setup failed",
    url: "https://github.com/heypinchy/pinchy/issues/849",
    createdAt: "2026-07-21T10:54:16Z",
    authorLogin: "Flindor",
    authorAssociation: "NONE",
    comments: [],
  });
  assert.deepEqual(second.comments, [
    { authorLogin: "clemenshelm", authorAssociation: "OWNER" },
  ]);
});

test("parseIssuesResponse feeds findUnansweredIssues without further massaging", () => {
  const overdue = findUnansweredIssues(parseIssuesResponse(GRAPHQL_RESPONSE), {
    now: NOW,
    graceHours: 48,
  });
  assert.deepEqual(
    overdue.map((i) => i.number),
    [849],
  );
});

test("parseIssuesResponse survives a deleted author account", () => {
  const response = {
    data: {
      repository: {
        issues: {
          nodes: [
            {
              number: 7,
              title: "Ghost report",
              url: "https://github.com/heypinchy/pinchy/issues/7",
              createdAt: "2026-07-01T00:00:00Z",
              authorAssociation: "NONE",
              author: null,
              comments: {
                nodes: [{ authorAssociation: "NONE", author: null }],
              },
            },
          ],
        },
      },
    },
  };
  const [parsed] = parseIssuesResponse(response);
  assert.equal(parsed.authorLogin, null);
  assert.deepEqual(parsed.comments, [
    { authorLogin: null, authorAssociation: "NONE" },
  ]);
});

test("parseIssuesResponse refuses to decode a payload it does not recognise", () => {
  // An auth failure or a renamed field must stop the sweep loudly. Returning
  // [] here would report "nothing is waiting" — the exact silent-green this
  // whole check exists to prevent.
  assert.throws(
    () => parseIssuesResponse({ errors: [{ message: "Bad credentials" }] }),
    /Bad credentials/,
  );
  assert.throws(() => parseIssuesResponse({}), /unexpected/i);
});

// The `issues` webhook speaks snake_case and nests the author under `user`,
// where GraphQL says camelCase and `author`. Reading the wrong one yields
// `undefined`, which decodes as "external" and would label every issue we
// open ourselves.
test("parseIssueEvent decodes the issues webhook payload", () => {
  const parsed = parseIssueEvent({
    action: "opened",
    issue: {
      number: 849,
      title: "Error: Setup failed",
      html_url: "https://github.com/heypinchy/pinchy/issues/849",
      created_at: "2026-07-21T10:54:16Z",
      author_association: "NONE",
      user: { login: "Flindor" },
    },
  });

  assert.deepEqual(parsed, {
    number: 849,
    title: "Error: Setup failed",
    url: "https://github.com/heypinchy/pinchy/issues/849",
    createdAt: "2026-07-21T10:54:16Z",
    authorLogin: "Flindor",
    authorAssociation: "NONE",
    comments: [],
  });
});

test("parseIssueEvent output classifies through the same rule as the sweep", () => {
  const external = parseIssueEvent({
    issue: {
      number: 1,
      title: "t",
      html_url: "u",
      created_at: "2026-07-21T10:54:16Z",
      author_association: "NONE",
      user: { login: "Flindor" },
    },
  });
  const ours = parseIssueEvent({
    issue: {
      number: 2,
      title: "t",
      html_url: "u",
      created_at: "2026-07-21T10:54:16Z",
      author_association: "OWNER",
      user: { login: "clemenshelm" },
    },
  });

  assert.equal(isExternalIssue(external), true);
  assert.equal(isExternalIssue(ours), false);
});

test("parseIssueEvent refuses a payload with no issue", () => {
  assert.throws(() => parseIssueEvent({ action: "opened" }), /unexpected/i);
});

// ---------------------------------------------------------------------------
// Wiring guards.
//
// The logic above is the cheap half. These pin the workflow that runs it,
// because every way this check can fail is a way it stays GREEN while nobody
// is watching the issue tracker.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/issue-triage.yml");

function workflowSource() {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

/** Strips comment-only lines so a guard can't be satisfied by prose. */
function uncommented(yaml) {
  return yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/**
 * Reads each job's own `permissions:` mapping out of the workflow text.
 *
 * There is no YAML parser at the repo root (husky, lint-staged and prettier are
 * the only root devDependencies), so this walks indentation: a job is a
 * two-space key under `jobs:`, its permissions are the four-space `permissions:`
 * block, and the entries sit six spaces in. Anything shaped differently yields
 * no entry, which fails the assertion rather than passing it.
 */
function jobPermissions(yaml) {
  const jobs = {};
  let job = null;
  let inPermissions = false;

  for (const line of yaml.split("\n")) {
    const jobStart = /^ {2}([\w-]+):\s*$/.exec(line);
    if (jobStart) {
      job = jobStart[1];
      jobs[job] = {};
      inPermissions = false;
      continue;
    }
    if (!job) continue;

    if (/^ {4}permissions:\s*$/.test(line)) {
      inPermissions = true;
      continue;
    }
    const entry = /^ {6}([\w-]+):\s*(\S+)\s*$/.exec(line);
    if (inPermissions && entry) {
      jobs[job][entry[1]] = entry[2];
      continue;
    }
    if (line.trim() && !/^ {6}/.test(line)) inPermissions = false;
  }
  return jobs;
}

test("the triage workflow exists", () => {
  assert.ok(
    existsSync(WORKFLOW_PATH),
    `expected a workflow at ${WORKFLOW_PATH}`,
  );
});

test("the triage workflow runs both scripts", () => {
  const yaml = uncommented(workflowSource());
  assert.match(yaml, /scripts\/triage-new-issue\.mjs/);
  assert.match(yaml, /scripts\/check-unanswered-issues\.mjs/);
});

test("both scripts the workflow names actually exist", () => {
  for (const script of [
    "scripts/triage-new-issue.mjs",
    "scripts/check-unanswered-issues.mjs",
  ]) {
    assert.ok(existsSync(join(REPO_ROOT, script)), `${script} is missing`);
  }
});

test("both scripts resolve write access instead of trusting the association", () => {
  // The unit tests above prove the rule; nothing in them proves either script
  // still calls it. Delete the annotate step and every test here stays green
  // while the sweep goes back to reporting the whole tracker — which is how
  // this shipped in the first place.
  for (const script of [
    "scripts/triage-new-issue.mjs",
    "scripts/check-unanswered-issues.mjs",
  ]) {
    const source = readFileSync(join(REPO_ROOT, script), "utf8");
    assert.match(
      source,
      /annotateWriteAccess\(/,
      `${script} must annotate write access before classifying`,
    );
    assert.match(
      source,
      /createWriteAccessResolver\(/,
      `${script} must pass the real resolver, not a stub`,
    );
  }
});

test("the triage workflow reacts to new issues and sweeps on a schedule", () => {
  const yaml = uncommented(workflowSource());
  assert.match(yaml, /^\s+issues:\n\s+types:.*opened/m);
  assert.match(yaml, /schedule:/);
  assert.match(yaml, /workflow_dispatch:/);
});

test("the triage workflow may write labels", () => {
  const yaml = uncommented(workflowSource());
  assert.match(yaml, /issues:\s*write/);
});

test("the sweep is never allowed to pass while issues are waiting", () => {
  // A red run IS the notification — GitHub emails the repo owner when a
  // scheduled workflow fails. `continue-on-error`, `|| true` or an `exit 0`
  // rescue would keep the run green and silently restore the exact failure
  // mode #849 shipped: nobody finds out.
  const yaml = uncommented(workflowSource());
  assert.doesNotMatch(yaml, /continue-on-error/);
  assert.doesNotMatch(yaml, /\|\|\s*true/);
  assert.doesNotMatch(yaml, /exit 0/);
});

test("the triage workflow grants the repo read access its checkout needs", () => {
  // A `permissions:` block sets every scope it does NOT list to no access.
  // This workflow checks out the repo to run the scripts, so it needs
  // `contents: read` spelled out.
  //
  // Measured, not assumed: a canary run on 2026-07-30 with `issues: write`
  // alone reported "Issues: write / Metadata: read" and checkout STILL
  // succeeded — cloning a public repo needs no authorization. So this is not a
  // live break; it is a dependency on the repo staying public that nothing
  // would state. Making the grant explicit costs one line and removes it.
  const yaml = uncommented(workflowSource());
  assert.match(yaml, /contents:\s*read/);
});

test("the sweep is not handed write access it never uses", () => {
  // Only the labelling job writes. Granting the sweep `issues: write` too
  // would hand a token that can edit the tracker to a job that only reads it.
  const permissions = jobPermissions(uncommented(workflowSource()));
  assert.equal(permissions["unanswered-sweep"]?.issues, "read");
  assert.equal(permissions["label-new-issue"]?.issues, "write");
});

test("the sweep only runs on weekdays", () => {
  // Grace is measured in plain hours rather than business days, which keeps
  // the logic free of calendar special cases. The weekday-only cron is what
  // pays for that simplification: a Friday-evening report is reported Monday
  // morning instead of waking anyone on Sunday.
  const yaml = uncommented(workflowSource());
  const cron = yaml.match(/cron:\s*["']([^"']+)["']/);
  assert.ok(cron, "expected a cron expression in the schedule trigger");
  const dayOfWeek = cron[1].trim().split(/\s+/)[4];
  assert.equal(
    dayOfWeek,
    "1-5",
    `expected a weekday-only cron, got "${cron[1]}"`,
  );
});

// One page is not the tracker. At the time this was written the repo had 151
// open issues against a 100-item page — asking for the newest 100 would have
// cut off exactly the 51 oldest, i.e. the ones waiting longest. A sweep that
// silently reads part of the tracker reports "nothing is waiting" for the
// half it never looked at.
test("parsePageInfo reports that more issues are waiting behind a cursor", () => {
  const info = parsePageInfo({
    data: {
      repository: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjEwMA==" },
        },
      },
    },
  });
  assert.deepEqual(info, { hasNextPage: true, endCursor: "Y3Vyc29yOjEwMA==" });
});

test("parsePageInfo reports the last page", () => {
  const info = parsePageInfo({
    data: {
      repository: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  });
  assert.deepEqual(info, { hasNextPage: false, endCursor: null });
});

test("parsePageInfo refuses a response with no page info", () => {
  // Dropping `pageInfo` from the query would otherwise degrade to "one page
  // is all there is" — a silent truncation of the sweep.
  assert.throws(
    () => parsePageInfo({ data: { repository: { issues: { nodes: [] } } } }),
    /pageInfo/,
  );
});

test("the sweep query asks for every page, not just the first", () => {
  const source = readFileSync(
    join(REPO_ROOT, "scripts/check-unanswered-issues.mjs"),
    "utf8",
  );
  assert.match(source, /pageInfo/, "the query must select pageInfo");
  assert.match(source, /hasNextPage/, "the script must follow the cursor");
});

/**
 * Counts the pipes Markdown will read as cell separators — a pipe preceded by
 * an even number of backslashes is structural, an odd number escapes it. A
 * four-column row must have exactly five.
 */
function structuralPipes(row) {
  let count = 0;
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== "|") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && row[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) count++;
  }
  return count;
}

test("formatOverdueSummary escapes a backslash before the pipe it protects", () => {
  // Escaping `|` but not `\` is worse than not escaping at all: a title
  // containing `\|` becomes `\\|`, which Markdown reads as a literal
  // backslash followed by a LIVE cell separator. Found by CodeQL
  // (js/incomplete-sanitization) after the first version shipped.
  const summary = formatOverdueSummary([
    {
      number: 1,
      title: "Crash \\| on save",
      url: "https://example.test/1",
      authorLogin: "outsider",
      waitingDays: 2,
    },
  ]);
  const row = summary.split("\n").find((line) => line.includes("Crash"));
  assert.equal(
    structuralPipes(row),
    5,
    `a four-column row must have exactly 5 separators: ${row}`,
  );
});

test("formatOverdueSummary keeps the plain-pipe case structural too", () => {
  const summary = formatOverdueSummary([
    {
      number: 1,
      title: "Crash | on save",
      url: "https://example.test/1",
      authorLogin: "outsider",
      waitingDays: 2,
    },
  ]);
  const row = summary.split("\n").find((line) => line.includes("Crash"));
  assert.equal(structuralPipes(row), 5, `unescaped separator leaked: ${row}`);
});

test("parseIssueEvent insists on a numeric issue number", () => {
  // The number lands in a request path. It arrives from a file on disk
  // (GITHUB_EVENT_PATH), so validating it here is what keeps a malformed or
  // tampered payload from steering the URL — CodeQL js/file-access-to-http.
  for (const number of ["12/../../foo", "", null, undefined, 1.5, -3, NaN]) {
    assert.throws(
      () =>
        parseIssueEvent({
          issue: {
            number,
            title: "t",
            html_url: "u",
            created_at: "2026-07-21T10:54:16Z",
            author_association: "NONE",
            user: { login: "x" },
          },
        }),
      /issue number/i,
      `expected a throw for number=${String(number)}`,
    );
  }
});

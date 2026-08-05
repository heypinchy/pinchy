import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  addLabels,
  createWriteAccessResolver,
  currentRepo,
  ensureLabel,
  graphql,
} from "./github-api.mjs";

/**
 * This client is thin, but it is the half of the triage scripts that talks to
 * the network — so its failure modes are the ones nobody sees until the day the
 * sweep needs to work. Two of them matter:
 *
 *   - a non-2xx must THROW, never be swallowed into a silent no-op,
 *   - the issue number must not be able to steer the request path (it arrives
 *     from a webhook payload read off disk — CodeQL js/file-access-to-http).
 *
 * fetch is stubbed rather than mocked through a library: the point is to pin
 * what URL and method this code produces, and a recorded call says that
 * directly.
 */

const REPO = { owner: "heypinchy", name: "pinchy" };

let calls;
let realFetch;
let realEnv;

function stubFetch(responses) {
  const queue = [...responses];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    const next = queue.shift() ?? { status: 200, body: "{}" };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body ?? "",
    };
  };
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  realEnv = {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
  };
  process.env.GITHUB_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv.token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = realEnv.token;
  if (realEnv.repo === undefined) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY = realEnv.repo;
});

test("currentRepo splits the slug Actions provides", () => {
  process.env.GITHUB_REPOSITORY = "heypinchy/pinchy";
  assert.deepEqual(currentRepo(), { owner: "heypinchy", name: "pinchy" });
});

test("currentRepo refuses a missing or malformed slug", () => {
  delete process.env.GITHUB_REPOSITORY;
  assert.throws(() => currentRepo(), /GITHUB_REPOSITORY/);
  process.env.GITHUB_REPOSITORY = "pinchy";
  assert.throws(() => currentRepo(), /GITHUB_REPOSITORY/);
});

test("a request without a token fails before reaching the network", () => {
  delete process.env.GITHUB_TOKEN;
  stubFetch([]);
  assert.rejects(() => graphql("query {}", {}), /GITHUB_TOKEN/);
  assert.deepEqual(calls, []);
});

test("graphql surfaces a transport failure with the response body", async () => {
  stubFetch([{ status: 401, body: '{"message":"Bad credentials"}' }]);
  await assert.rejects(() => graphql("query {}", {}), /401.*Bad credentials/s);
});

test("graphql returns the envelope so the caller can inspect `errors`", async () => {
  stubFetch([{ status: 200, body: '{"data":{"repository":null}}' }]);
  const envelope = await graphql("query {}", { owner: "a" });
  assert.deepEqual(envelope, { data: { repository: null } });
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].method, "POST");
});

test("ensureLabel treats an existing label as success", async () => {
  // 422 is GitHub's "already_exists". Throwing on it would make the labelling
  // job fail on every issue after the first.
  stubFetch([{ status: 422, body: '{"message":"Validation Failed"}' }]);
  await ensureLabel(REPO, { name: "external", color: "1D76DB" });
  assert.equal(calls.length, 1);
});

test("ensureLabel still throws on a real failure", async () => {
  stubFetch([{ status: 500, body: "boom" }]);
  await assert.rejects(
    () => ensureLabel(REPO, { name: "external", color: "1D76DB" }),
    /external.*500/s,
  );
});

test("addLabels posts to the issue's own labels endpoint", async () => {
  stubFetch([{ status: 200, body: "[]" }]);
  await addLabels(REPO, 849, ["external", "triage"]);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/heypinchy/pinchy/issues/849/labels",
  );
  assert.deepEqual(JSON.parse(calls[0].body), {
    labels: ["external", "triage"],
  });
});

test("addLabels refuses to let the issue number steer the request path", async () => {
  // The number originates in a webhook payload read off disk. parseIssueEvent
  // already rejects a non-integer; this is the second lock, so the function
  // that builds the URL does not depend on its caller having checked.
  for (const number of [
    "849/../../../repos/attacker/x",
    "",
    null,
    1.5,
    -3,
    NaN,
  ]) {
    stubFetch([{ status: 200, body: "[]" }]);
    await assert.rejects(
      () => addLabels(REPO, number, ["external"]),
      /Refusing to build a request path/,
      `expected a throw for number=${String(number)}`,
    );
    assert.deepEqual(calls, [], "no request may be sent for a bad number");
    calls = [];
  }
});

test("addLabels surfaces a failed write instead of reporting success", async () => {
  stubFetch([{ status: 403, body: '{"message":"Resource not accessible"}' }]);
  await assert.rejects(() => addLabels(REPO, 849, ["external"]), /849.*403/s);
});

test("the write-access resolver asks the repo about that one person", async () => {
  stubFetch([{ status: 200, body: '{"permission":"admin"}' }]);
  const resolve = createWriteAccessResolver(REPO);
  assert.equal(await resolve("clemenshelm"), true);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/heypinchy/pinchy/collaborators/clemenshelm/permission",
  );
});

test("the write-access resolver counts the roles that can actually write", async () => {
  // `triage` can manage issues but cannot push, and `read` is a stranger with
  // a subscription. Both err toward "external", which keeps the sweep loud —
  // the direction this check is supposed to fail in.
  for (const [permission, expected] of [
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", false],
    ["read", false],
    ["none", false],
  ]) {
    stubFetch([{ status: 200, body: JSON.stringify({ permission }) }]);
    assert.equal(
      await createWriteAccessResolver(REPO)("someone"),
      expected,
      `permission=${permission}`,
    );
  }
});

test("the write-access resolver treats an unknown account as an outsider", async () => {
  stubFetch([{ status: 404, body: '{"message":"Not Found"}' }]);
  assert.equal(await createWriteAccessResolver(REPO)("ghost"), false);
});

test("the write-access resolver refuses to guess when the lookup breaks", async () => {
  // A 403 here would otherwise reproduce the 2026-08-05 incident exactly:
  // every author silently demoted to outsider, 99 wrong names in the alarm.
  // Failing loudly costs one red run; guessing costs the alarm's credibility.
  stubFetch([{ status: 403, body: '{"message":"Resource not accessible"}' }]);
  await assert.rejects(
    () => createWriteAccessResolver(REPO)("clemenshelm"),
    /clemenshelm.*403/s,
  );
});

test("the write-access resolver refuses an unreadable permission body", async () => {
  stubFetch([{ status: 200, body: "not json" }]);
  await assert.rejects(
    () => createWriteAccessResolver(REPO)("clemenshelm"),
    /clemenshelm/,
  );
});

test("the write-access resolver refuses to let a login steer the request path", async () => {
  // Logins arrive from the tracker, i.e. from strangers. Same lock as
  // addLabels: the URL builder does not trust its caller to have checked.
  for (const login of [
    "clemenshelm/../../attacker/x",
    "a b",
    "",
    null,
    "dependabot[bot]",
  ]) {
    stubFetch([{ status: 200, body: '{"permission":"admin"}' }]);
    await assert.rejects(
      () => createWriteAccessResolver(REPO)(login),
      /Refusing to build a request path/,
      `expected a throw for login=${String(login)}`,
    );
    assert.deepEqual(calls, [], "no request may be sent for a bad login");
    calls = [];
  }
});

test("the write-access resolver asks about each person only once", async () => {
  stubFetch([
    { status: 200, body: '{"permission":"admin"}' },
    { status: 500, body: "should never be reached" },
  ]);
  const resolve = createWriteAccessResolver(REPO);
  assert.equal(await resolve("clemenshelm"), true);
  assert.equal(await resolve("clemenshelm"), true);
  assert.equal(calls.length, 1);
});

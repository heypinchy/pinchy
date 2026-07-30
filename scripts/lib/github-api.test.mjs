import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addLabels, currentRepo, ensureLabel, graphql } from "./github-api.mjs";

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

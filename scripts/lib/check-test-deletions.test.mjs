import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countTestCases,
  analyzeChanges,
  parseOverride,
  diffArgs,
  commitLogArgs,
} from "./check-test-deletions.mjs";

test("diffArgs uses merge-base two-dot range when a merge-base is known", () => {
  // Correct PR semantics: only changes introduced by the branch.
  assert.deepEqual(diffArgs("abc123", "origin/main"), [
    "diff",
    "--name-status",
    "-M",
    "abc123..HEAD",
  ]);
});

test("diffArgs falls back to tip-to-tip two-dot when no merge-base (shallow CI)", () => {
  // Never uses three-dot (origin/main...HEAD), which throws in a shallow clone
  // with no common ancestor. Tip-to-tip always resolves once base is fetched.
  assert.deepEqual(diffArgs(null, "origin/main"), [
    "diff",
    "--name-status",
    "-M",
    "origin/main",
    "HEAD",
  ]);
});

test("diffArgs treats an empty merge-base string as no merge-base", () => {
  assert.deepEqual(diffArgs("", "origin/main"), [
    "diff",
    "--name-status",
    "-M",
    "origin/main",
    "HEAD",
  ]);
});

test("commitLogArgs uses merge-base two-dot range when a merge-base is known", () => {
  // Same range the diff walks — only commits introduced by the branch, so a
  // trailer on the PR's own commit is the one that authorizes its deletions.
  assert.deepEqual(commitLogArgs("abc123"), [
    "log",
    "--format=%B",
    "abc123..HEAD",
  ]);
});

test("commitLogArgs reads the explicit PR head ref, bypassing the shallow merge-commit graft", () => {
  // The real CI failure: actions/checkout gives a shallow PR *merge* commit as
  // HEAD, whose feature-side parent (carrying the Allow-test-deletion trailer)
  // is a graft — so `git log HEAD` never reaches it and a valid override is
  // dropped. The PR head sha's OWN history is ungrafted, so reading trailers
  // from it is deterministic. Head ref wins over any merge-base range.
  assert.deepEqual(commitLogArgs("abc123", "deadbeef"), [
    "log",
    "--format=%B",
    "-n",
    "200",
    "deadbeef",
  ]);
  assert.deepEqual(commitLogArgs(null, "deadbeef"), [
    "log",
    "--format=%B",
    "-n",
    "200",
    "deadbeef",
  ]);
});

test("commitLogArgs ignores an empty head ref and falls back to the merge-base range", () => {
  assert.deepEqual(commitLogArgs("abc123", ""), [
    "log",
    "--format=%B",
    "abc123..HEAD",
  ]);
});

test("commitLogArgs falls back to bounded HEAD history when no merge-base (shallow CI)", () => {
  // The bug this guards against: with no merge-base, `origin/main..HEAD` can
  // resolve empty in a shallow clone, silently dropping the very trailer that
  // authorizes the deletion — so the diff sees removals but the override is
  // missed and CI fails a PR that IS authorized. Reading HEAD's own recent
  // history always contains the PR commit (and, for a PR merge ref, its
  // feature-branch parent). Bounded to the CI fetch depth so a full-clone
  // fallback can't walk all of history.
  assert.deepEqual(commitLogArgs(null), [
    "log",
    "--format=%B",
    "-n",
    "200",
    "HEAD",
  ]);
});

test("commitLogArgs treats an empty merge-base string as no merge-base", () => {
  assert.deepEqual(commitLogArgs(""), [
    "log",
    "--format=%B",
    "-n",
    "200",
    "HEAD",
  ]);
});

test("countTestCases counts it/test/xit/fit invocations", () => {
  const src = `
    describe("group", () => {
      it("a", () => {});
      test("b", () => {});
      xit("c", () => {});
      fit("d", () => {});
    });
  `;
  // describe is a group, not a case — only the four cases count.
  assert.equal(countTestCases(src), 4);
});

test("countTestCases counts modifier and .each forms", () => {
  const src = `
    it.skip("a", () => {});
    it.only("b", () => {});
    test.concurrent("c", () => {});
    it.each([1, 2])("d %s", () => {});
    test.each\`
      x
    \`("e", () => {});
  `;
  assert.equal(countTestCases(src), 5);
});

test("countTestCases does not count identifiers that merely contain a keyword", () => {
  const src = `
    commit("not a test");
    submit("nope");
    const latest = compute();
    obj.it("method call, not a test case");
    audit("x");
  `;
  assert.equal(countTestCases(src), 0);
});

test("analyzeChanges reports all cases removed when a test file is deleted", () => {
  const before = `it("a", () => {}); it("b", () => {});`;
  const result = analyzeChanges([
    { path: "a.test.ts", status: "deleted", before, after: null },
  ]);
  assert.equal(result.netRemoved, 2);
  assert.deepEqual(result.removals, [
    { path: "a.test.ts", before: 2, after: 0, delta: -2 },
  ]);
});

test("analyzeChanges flags net removal inside a modified file", () => {
  const before = `it("a",()=>{}); it("b",()=>{}); it("c",()=>{});`;
  const after = `it("a",()=>{});`;
  const result = analyzeChanges([
    { path: "x.test.ts", status: "modified", before, after },
  ]);
  assert.equal(result.netRemoved, 2);
  assert.equal(result.removals.length, 1);
  assert.equal(result.removals[0].delta, -2);
});

test("analyzeChanges treats moving a test between files as net zero", () => {
  const result = analyzeChanges([
    {
      path: "a.test.ts",
      status: "modified",
      before: `it("x",()=>{}); it("y",()=>{});`,
      after: `it("x",()=>{});`,
    },
    {
      path: "b.test.ts",
      status: "modified",
      before: `it("z",()=>{});`,
      after: `it("z",()=>{}); it("y",()=>{});`,
    },
  ]);
  assert.equal(result.netRemoved, 0);
});

test("analyzeChanges returns netRemoved 0 when tests are only added", () => {
  const result = analyzeChanges([
    {
      path: "n.test.ts",
      status: "added",
      before: null,
      after: `it("a",()=>{}); it("b",()=>{});`,
    },
  ]);
  assert.equal(result.netRemoved, 0);
  assert.deepEqual(result.removals, []);
});

test("parseOverride allows when the CI label env is set", () => {
  assert.equal(parseOverride({ envValue: "true", messages: [] }).allowed, true);
  assert.equal(parseOverride({ envValue: "1", messages: [] }).allowed, true);
});

test("parseOverride ignores falsey/empty env values", () => {
  assert.equal(parseOverride({ envValue: "", messages: [] }).allowed, false);
  assert.equal(
    parseOverride({ envValue: "false", messages: [] }).allowed,
    false,
  );
  assert.equal(
    parseOverride({ envValue: undefined, messages: [] }).allowed,
    false,
  );
});

test("parseOverride allows a commit trailer that references an issue", () => {
  const messages = ["fix: dedup tests\n\nAllow-test-deletion: #449"];
  const result = parseOverride({ envValue: "", messages });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /#449/);
});

test("parseOverride accepts a full issue URL in the trailer", () => {
  const messages = [
    "Allow-test-deletion: https://github.com/heypinchy/pinchy/issues/12",
  ];
  assert.equal(parseOverride({ envValue: "", messages }).allowed, true);
});

test("parseOverride rejects a trailer without an issue reference", () => {
  // Mirrors no-untracked-skips: a bare promise is not tracking.
  const messages = [
    "chore: cleanup\n\nAllow-test-deletion: yes because reasons",
  ];
  assert.equal(parseOverride({ envValue: "", messages }).allowed, false);
});

test("parseOverride ignores an inline prose mention of the trailer phrase", () => {
  // A commit body may *talk about* the trailer (docs, a placeholder like
  // `Allow-test-deletion: #NNN`) without being one. Only a real trailer at the
  // start of a line counts, so prose can't accidentally authorize — or, worse,
  // an invalid-ref prose mention can't mask a real trailer elsewhere.
  const messages = [
    "fix: explain the guard\n\nA valid `Allow-test-deletion: #NNN` trailer was dropped.",
  ];
  assert.equal(parseOverride({ envValue: "", messages }).allowed, false);
});

test("parseOverride finds a real trailer even when an earlier line mentions the phrase without a valid ref", () => {
  // Combined-commit-log case: `git log` concatenates every commit's message, so
  // an earlier commit's prose mention (or an invalid-ref trailer) precedes the
  // real one. The scan must not stop at the first match — it must find the
  // authorizing trailer wherever it is.
  const messages = [
    "fix: explain\n\nMentions `Allow-test-deletion: #NNN` in prose.\n\n" +
      "refactor: remove dead tests\n\nAllow-test-deletion: #338",
  ];
  const result = parseOverride({ envValue: "", messages });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /#338/);
});

test("parseOverride scans past an invalid-ref trailer to a later valid one", () => {
  const messages = ["Allow-test-deletion: soon\nAllow-test-deletion: #77"];
  const result = parseOverride({ envValue: "", messages });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /#77/);
});

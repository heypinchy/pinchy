import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countTestCases,
  analyzeChanges,
  parseOverride,
} from "./check-test-deletions.mjs";

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

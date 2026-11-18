import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateBaseRefs,
  decideDocsReview,
  isPrCreateCommand,
  parseBaseRef,
} from "./docs-review-hook.mjs";

const SURFACE = [
  {
    path: "packages/web/src/app/api/automations/route.ts",
    what: "an API route",
    docs: "docs/src/content/docs/reference/api.mdx",
  },
];

test("isPrCreateCommand recognises the command, including in a chain", () => {
  assert.equal(isPrCreateCommand("gh pr create --fill"), true);
  assert.equal(isPrCreateCommand("git push -u origin x && gh pr create"), true);
});

test("isPrCreateCommand leaves neighbouring gh commands alone", () => {
  for (const c of ["gh pr view 1", "gh pr checks --watch", "gh pr list"]) {
    assert.equal(isPrCreateCommand(c), false, c);
  }
});

test("parseBaseRef reads the target branch verbatim", () => {
  assert.equal(parseBaseRef("gh pr create --base main"), "main");
  assert.equal(parseBaseRef("gh pr create -B release/0.9"), "release/0.9");
  assert.equal(parseBaseRef("gh pr create"), "main");
});

test("candidateBaseRefs prefers the remote spelling but keeps the literal one", () => {
  // The first version of this guessed, and got `--base v0.8.0` wrong: a tag
  // has no `origin/` counterpart, the merge-base lookup threw, and the hook
  // failed open on a branch it should have judged. Offer both, let git decide.
  assert.deepEqual(candidateBaseRefs("main"), ["origin/main", "main"]);
  assert.deepEqual(candidateBaseRefs("v0.8.0"), ["origin/v0.8.0", "v0.8.0"]);
  assert.deepEqual(candidateBaseRefs("origin/main"), ["origin/main"]);
});

test("decideDocsReview stands aside when nothing user-visible moved", () => {
  assert.deepEqual(
    decideDocsReview({
      surfaces: [],
      headSha: "abc",
      markedSha: null,
      override: { allowed: false },
    }),
    { allow: true },
  );
});

test("decideDocsReview blocks a user-visible change with no review", () => {
  const d = decideDocsReview({
    surfaces: SURFACE,
    headSha: "abc",
    markedSha: null,
    override: { allowed: false },
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /review-docs/);
  assert.match(d.reason, /automations\/route\.ts/);
  assert.match(d.reason, /Docs-not-needed/);
});

test("decideDocsReview accepts a review recorded for this exact commit", () => {
  assert.deepEqual(
    decideDocsReview({
      surfaces: SURFACE,
      headSha: "abc",
      markedSha: "abc\n",
      override: { allowed: false },
    }),
    { allow: true },
  );
});

test("a review of an earlier commit does not cover this branch", () => {
  const d = decideDocsReview({
    surfaces: SURFACE,
    headSha: "def",
    markedSha: "abc\n",
    override: { allowed: false },
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /no longer covers this branch/);
});

test("the commit-trailer escape hatch works here too", () => {
  // One hatch, two enforcement points: the same trailer waives the CI gate.
  assert.deepEqual(
    decideDocsReview({
      surfaces: SURFACE,
      headSha: "abc",
      markedSha: null,
      override: { allowed: true, reason: "Docs-not-needed trailer" },
    }),
    { allow: true },
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import { maskFencedBlocks, sliceSectionBody } from "./mdx-fences.mjs";

// ─── maskFencedBlocks ────────────────────────────────────────────────────────

test("maskFencedBlocks blanks a heading inside a fence and keeps one outside", () => {
  const masked = maskFencedBlocks(
    ["```markdown", "## Inside", "```", "## Outside"].join("\n"),
  );
  assert.doesNotMatch(masked, /## Inside/);
  assert.match(masked, /## Outside/);
});

test("maskFencedBlocks preserves length and line count", () => {
  const src = ["```markdown", "## Inside", "```", "## Outside"].join("\n");
  const masked = maskFencedBlocks(src);
  assert.equal(
    masked.length,
    src.length,
    "indices computed on the mask must still address the original",
  );
  assert.equal(masked.split("\n").length, src.split("\n").length);
});

test("maskFencedBlocks closes only on a fence at least as long as the opener", () => {
  // Prettier writes ````markdown when the sample itself contains ```.
  const masked = maskFencedBlocks(
    ["````markdown", "```", "## Inside", "````", "## Outside"].join("\n"),
  );
  assert.doesNotMatch(masked, /## Inside/);
  assert.match(masked, /## Outside/);
});

test("maskFencedBlocks does not let a ``` close a ~~~ fence", () => {
  const masked = maskFencedBlocks(
    ["~~~markdown", "```", "## Inside", "~~~", "## Outside"].join("\n"),
  );
  assert.doesNotMatch(masked, /## Inside/);
  assert.match(masked, /## Outside/);
});

test("maskFencedBlocks masks a ~~~ fence", () => {
  const masked = maskFencedBlocks(
    ["~~~markdown", "## Inside", "~~~", "## Outside"].join("\n"),
  );
  assert.doesNotMatch(masked, /## Inside/);
  assert.match(masked, /## Outside/);
});

// An unclosed fence is the one case where CommonMark and this module disagree,
// deliberately. CommonMark runs it to end of document, which here would delete
// every following section from the caller's view — silently, and silence is
// the whole failure mode this module removes. Left unmasked, a malformed file
// makes a guard see phantom sections and fail loudly instead.
test("maskFencedBlocks leaves an UNCLOSED fence unmasked rather than swallowing the rest of the file", () => {
  const src = [
    "## Upgrading from v0.8.0 to v0.9.0",
    "```markdown",
    "sample",
    "",
    "## Upgrading from v0.7.0 to v0.8.0",
    "Older.",
  ].join("\n");
  assert.equal(maskFencedBlocks(src), src);
});

test("maskFencedBlocks handles two fences in one document", () => {
  const masked = maskFencedBlocks(
    [
      "```bash",
      "## one",
      "```",
      "## kept",
      "```markdown",
      "## two",
      "```",
    ].join("\n"),
  );
  assert.doesNotMatch(masked, /## one/);
  assert.doesNotMatch(masked, /## two/);
  assert.match(masked, /## kept/);
});

// ─── sliceSectionBody ────────────────────────────────────────────────────────

test("sliceSectionBody returns the ORIGINAL bytes, cut at a real boundary", () => {
  const mdx = [
    "## A",
    "",
    "```markdown",
    "## Not a boundary",
    "```",
    "",
    "tail of A",
    "",
    "## B",
    "",
    "body of B",
  ].join("\n");
  const start = mdx.indexOf("\n", mdx.indexOf("## A"));
  const { body, end } = sliceSectionBody(mdx, start);
  assert.match(body, /## Not a boundary/, "fenced text must survive verbatim");
  assert.match(body, /tail of A/);
  assert.doesNotMatch(body, /body of B/);
  assert.equal(mdx.slice(end).startsWith("## B"), true);
});

test("sliceSectionBody runs to EOF when no further heading exists", () => {
  const mdx = "## A\n\nonly section";
  const { body, end } = sliceSectionBody(mdx, mdx.indexOf("\n"));
  assert.match(body, /only section/);
  assert.equal(end, mdx.length);
});

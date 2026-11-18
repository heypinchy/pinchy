import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findUnrenderedMarkup,
  collectPageText,
} from "./check-rendered-tables.mjs";

function makeDist(files) {
  const dir = mkdtempSync(join(tmpdir(), "check-rendered-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function withDist(files, fn) {
  const dist = makeDist(files);
  try {
    return fn(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

test("a rendered table produces no findings", () => {
  withDist(
    {
      "a/index.html":
        "<table><tr><th>Event Type</th></tr><tr><td>auth.login</td></tr></table>",
    },
    (dist) => assert.deepEqual(findUnrenderedMarkup(dist), []),
  );
});

test("flags a table that shipped as a paragraph of pipes", () => {
  // The v0.9.0 bug: @astrojs/mdx got `gfm: undefined` from astro@6's deprecated
  // `markdown.gfm`, so every .mdx table rendered as literal text.
  withDist(
    {
      "concepts/audit-trail/index.html":
        "<p>| Event Type | Description |\n| --- | --- |</p>",
    },
    (dist) => {
      const problems = findUnrenderedMarkup(dist);
      assert.equal(problems.length, 1);
      assert.equal(problems[0].route, "/concepts/audit-trail/");
      assert.match(problems[0].sample, /Event Type/);
    },
  );
});

test("flags the delimiter row on its own", () => {
  // Prose legitimately starts with "|" almost never, but a delimiter row is
  // unambiguous: it exists only as table syntax.
  withDist({ "a/index.html": "<p>| ------ | ------ |</p>" }, (dist) =>
    assert.equal(findUnrenderedMarkup(dist).length, 1),
  );
});

test("does not flag a pipe inside prose or code", () => {
  // `a | b` in a sentence, and shell pipes in code blocks, are not tables.
  withDist(
    {
      "a/index.html":
        "<p>Use the OR form, a | b, when either matches.</p>" +
        "<pre><code>| grep foo | wc -l</code></pre>",
    },
    (dist) => assert.deepEqual(findUnrenderedMarkup(dist), []),
  );
});

test("reports one finding per page, not one per row", () => {
  withDist(
    {
      "a/index.html": "<p>| A | B |</p><p>| --- | --- |</p><p>| 1 | 2 |</p>",
    },
    (dist) => assert.equal(findUnrenderedMarkup(dist).length, 1),
  );
});

test("collectPageText strips tags and decodes entities", () => {
  assert.equal(
    collectPageText("<p>| <code>a&amp;b</code> | x |</p>"),
    "| a&b | x |",
  );
});

test("walks nested directories and ignores non-HTML files", () => {
  withDist(
    {
      "index.html": "<p>ok</p>",
      "deep/nested/page/index.html": "<p>| A | B |</p>",
      "sitemap.xml": "<p>| A | B |</p>",
    },
    (dist) => {
      const problems = findUnrenderedMarkup(dist);
      assert.equal(problems.length, 1);
      assert.equal(problems[0].route, "/deep/nested/page/");
    },
  );
});

test("an empty dist yields no findings (the caller checks the count)", () => {
  withDist({ "sitemap.xml": "<urlset/>" }, (dist) =>
    assert.deepEqual(findUnrenderedMarkup(dist), []),
  );
});

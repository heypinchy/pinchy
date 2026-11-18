import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectBuiltDiagrams,
  countMermaidFencesIn,
  findDroppedDiagrams,
  mermaidFencesByRoute,
  routeForSourceFile,
} from "./check-rendered-diagrams.mjs";

function withTree(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "check-diagrams-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DIAGRAM =
  '<div class="mermaid" data-content="graph TD\n  A --&gt; B" data-status="loading"></div>';

// ── built output ──────────────────────────────────────────────────────────

test("a diagram container produces no findings", () => {
  withTree({ "architecture/index.html": DIAGRAM }, (dist) => {
    const built = collectBuiltDiagrams(dist);
    assert.deepEqual(built.codeRoutes, []);
    assert.deepEqual([...built.containers], [["/architecture/", 1]]);
    assert.equal(built.pages, 1);
  });
});

test("flags a mermaid block that Expressive Code rendered as code", () => {
  // The astro 7 trial upgrade (#851): @pasqal-io/starlight-client-mermaid
  // registered a remark plugin through `markdown.remarkPlugins`, which the
  // Sätteri processor never runs — so the diagram's source shipped as a code
  // block. Build green, every other check green.
  withTree(
    {
      "architecture/index.html":
        '<div class="expressive-code"><figure><pre data-language="mermaid"><code>' +
        '<div class="ec-line">graph TD</div></code></pre></figure></div>',
    },
    (dist) => {
      const built = collectBuiltDiagrams(dist);
      assert.deepEqual(built.codeRoutes, ["/architecture/"]);
      assert.equal(built.containers.size, 0);
    },
  );
});

test("flags a mermaid block from a plain Shiki or Prism renderer", () => {
  // The next code renderer will not be Expressive Code's markup, but it will
  // still say which language the block is.
  withTree(
    {
      "a/index.html":
        '<pre class="astro-code" data-language="mermaid"><code>graph TD</code></pre>',
      "b/index.html":
        '<pre><code class="language-mermaid">graph TD</code></pre>',
      "c/index.html": '<pre class="language-mermaid"><code>x</code></pre>',
    },
    (dist) => assert.equal(collectBuiltDiagrams(dist).codeRoutes.length, 3),
  );
});

test("does not flag other code blocks or prose that mentions mermaid", () => {
  withTree(
    {
      "a/index.html":
        '<p>We draw diagrams with Mermaid.</p><pre data-language="bash"><code>echo mermaid</code></pre>',
    },
    (dist) => assert.deepEqual(collectBuiltDiagrams(dist).codeRoutes, []),
  );
});

test("reports one finding per page and ignores non-HTML files", () => {
  withTree(
    {
      "a/index.html":
        '<pre data-language="mermaid"></pre><pre data-language="mermaid"></pre>',
      "llms-full.txt": '<pre data-language="mermaid"></pre>',
    },
    (dist) => {
      const built = collectBuiltDiagrams(dist);
      assert.deepEqual(built.codeRoutes, ["/a/"]);
      assert.equal(built.pages, 1);
    },
  );
});

test("counts diagram containers per page", () => {
  withTree(
    {
      "a/index.html": DIAGRAM + DIAGRAM,
      "deep/b/index.html": DIAGRAM,
      "c/index.html": '<div class="mermaid-legend"></div>',
    },
    (dist) =>
      assert.deepEqual(
        Object.fromEntries(collectBuiltDiagrams(dist).containers),
        { "/a/": 2, "/deep/b/": 1 },
      ),
  );
});

test("an empty dist/ reports zero pages, so the caller can refuse it", () => {
  // "✅ 0 diagrams" against an empty or relocated dist/ is a green light
  // earned by looking at nothing — same rule as check:rendered.
  withTree({ "robots.txt": "" }, (dist) =>
    assert.equal(collectBuiltDiagrams(dist).pages, 0),
  );
});

// ── source ────────────────────────────────────────────────────────────────

test("counts mermaid fences in .md and .mdx sources, per route", () => {
  withTree(
    {
      "a.mdx":
        "# A\n\n```mermaid\ngraph TD\n```\n\ntext\n\n```mermaid\nx\n```\n",
      "nested/b.md": "~~~mermaid\ngraph LR\n~~~\n",
      "c.mdx": "```bash\necho\n```\n",
      "d.txt": "```mermaid\nx\n```\n",
    },
    (src) =>
      assert.deepEqual(Object.fromEntries(mermaidFencesByRoute(src)), {
        "/a/": 2,
        "/nested/b/": 1,
      }),
  );
});

test("a mermaid fence quoted inside a longer fence is an example, not a diagram", () => {
  // A page documenting how to write a diagram shows the fence as code — that
  // one must stay code, so it must not be expected to render.
  assert.equal(
    countMermaidFencesIn(
      "````md\n```mermaid\ngraph TD\n```\n````\n\n```mermaid\nreal\n```\n",
      { mdx: true },
    ),
    1,
  );
});

test("an indented fence is a diagram in MDX but an indented code block in .md", () => {
  // MDX disables indented code, so a fence nested 4 spaces deep in a list item
  // or a <TabItem> still renders as a diagram — and must be expected to.
  const nested = "1. Step\n\n    ```mermaid\n    graph TD\n    ```\n";
  assert.equal(countMermaidFencesIn(nested, { mdx: true }), 1);
  assert.equal(countMermaidFencesIn(nested, { mdx: false }), 0);
});

test("a fence inside a comment is not a diagram", () => {
  // A commented-out block never renders; counting it would fail the check
  // and blame the renderer.
  assert.equal(
    countMermaidFencesIn("{/*\n```mermaid\nx\n```\n*/}\n", { mdx: true }),
    0,
  );
  assert.equal(
    countMermaidFencesIn("<!--\n```mermaid\nx\n```\n-->\n", { mdx: false }),
    0,
  );
  // A comment marker quoted inside a code block is code, not a comment.
  assert.equal(
    countMermaidFencesIn("```js\n{/*\n```\n\n```mermaid\nx\n```\n", {
      mdx: true,
    }),
    1,
  );
});

test("routes a source file the way Starlight serves it", () => {
  assert.equal(routeForSourceFile("architecture.mdx", ""), "/architecture/");
  assert.equal(routeForSourceFile("index.mdx", ""), "/");
  assert.equal(routeForSourceFile("guides/index.md", ""), "/guides/");
  assert.equal(routeForSourceFile("Guides/Setup.mdx", ""), "/guides/setup/");
  assert.equal(
    routeForSourceFile("old.mdx", "---\ntitle: X\nslug: new/place\n---\n"),
    "/new/place/",
  );
});

// ── comparison ────────────────────────────────────────────────────────────

test("a dropped diagram is named by its page, even when another page has extra", () => {
  // Site-wide totals would read 1 = 1 here and pass.
  assert.deepEqual(
    findDroppedDiagrams(
      new Map([["/architecture/", 1]]),
      new Map([["/elsewhere/", 1]]),
    ),
    [{ route: "/architecture/", fences: 1, containers: 0 }],
  );
  assert.deepEqual(
    findDroppedDiagrams(
      new Map([["/architecture/", 1]]),
      new Map([["/architecture/", 1]]),
    ),
    [],
  );
});

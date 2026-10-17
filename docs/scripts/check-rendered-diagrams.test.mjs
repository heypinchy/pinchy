import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countMermaidFences,
  findDiagramsShippedAsCode,
  countDiagramContainers,
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
    assert.deepEqual(findDiagramsShippedAsCode(dist), []);
    assert.equal(countDiagramContainers(dist), 1);
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
      const problems = findDiagramsShippedAsCode(dist);
      assert.equal(problems.length, 1);
      assert.equal(problems[0].route, "/architecture/");
      assert.equal(countDiagramContainers(dist), 0);
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
    (dist) => assert.equal(findDiagramsShippedAsCode(dist).length, 3),
  );
});

test("does not flag other code blocks or prose that mentions mermaid", () => {
  withTree(
    {
      "a/index.html":
        '<p>We draw diagrams with Mermaid.</p><pre data-language="bash"><code>echo mermaid</code></pre>',
    },
    (dist) => assert.deepEqual(findDiagramsShippedAsCode(dist), []),
  );
});

test("reports one finding per page and ignores non-HTML files", () => {
  withTree(
    {
      "a/index.html":
        '<pre data-language="mermaid"></pre><pre data-language="mermaid"></pre>',
      "llms-full.txt": '<pre data-language="mermaid"></pre>',
    },
    (dist) => assert.equal(findDiagramsShippedAsCode(dist).length, 1),
  );
});

test("counts every diagram container across pages", () => {
  withTree(
    {
      "a/index.html": DIAGRAM + DIAGRAM,
      "deep/b/index.html": DIAGRAM,
      "c/index.html": '<div class="mermaid-legend"></div>',
    },
    (dist) => assert.equal(countDiagramContainers(dist), 3),
  );
});

// ── source ────────────────────────────────────────────────────────────────

test("counts mermaid fences in .md and .mdx sources", () => {
  withTree(
    {
      "a.mdx":
        "# A\n\n```mermaid\ngraph TD\n```\n\ntext\n\n```mermaid\nx\n```\n",
      "nested/b.md": "~~~mermaid\ngraph LR\n~~~\n",
      "c.mdx": "```bash\necho\n```\n",
      "d.txt": "```mermaid\nx\n```\n",
    },
    (src) => assert.equal(countMermaidFences(src), 3),
  );
});

test("a mermaid fence quoted inside a longer fence is an example, not a diagram", () => {
  // A page documenting how to write a diagram shows the fence as code — that
  // one must stay code, so it must not be expected to render.
  withTree(
    {
      "a.mdx":
        "````md\n```mermaid\ngraph TD\n```\n````\n\n```mermaid\nreal\n```\n",
    },
    (src) => assert.equal(countMermaidFences(src), 1),
  );
});

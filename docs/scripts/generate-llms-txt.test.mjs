import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLlmsFullTxt,
  buildLlmsTxt,
  collectPages,
  INLINE_CODE,
  mdxToMarkdown,
  parseFrontmatter,
  readSiteUrl,
  routeForSourcePath,
  sectionForSourcePath,
  sortPages,
} from "./generate-llms-txt.mjs";

const SITE = "https://docs.heypinchy.com";
const CONTENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "content",
  "docs",
);

// ── frontmatter ───────────────────────────────────────────────────────────

test("parseFrontmatter reads the top-level title and description", () => {
  const { data, body } = parseFrontmatter(
    [
      "---",
      "title: Hardening Guide",
      "description: Security best practices.",
      "---",
      "",
      "Body text.",
    ].join("\n"),
    "guides/hardening.mdx",
  );
  assert.equal(data.title, "Hardening Guide");
  assert.equal(data.description, "Security best practices.");
  assert.equal(body.trim(), "Body text.");
});

test("parseFrontmatter ignores nested keys of the same name", () => {
  // index.mdx carries a splash `hero:` block whose own `title:` is indented.
  // Reading that one would title the whole site index after its hero.
  const { data } = parseFrontmatter(
    [
      "---",
      "title: Pinchy Documentation",
      "description: Enterprise AI agent platform.",
      "template: splash",
      "hero:",
      "  title: Not the page title",
      "  tagline: Nope",
      "---",
      "",
      "Body",
    ].join("\n"),
    "index.mdx",
  );
  assert.equal(data.title, "Pinchy Documentation");
});

test("parseFrontmatter keeps a colon inside a description", () => {
  const { data } = parseFrontmatter(
    [
      "---",
      "title: T",
      "description: Pinchy: governance for agents.",
      "---",
      "x",
    ].join("\n"),
    "a.mdx",
  );
  assert.equal(data.description, "Pinchy: governance for agents.");
});

test("parseFrontmatter unwraps a quoted value", () => {
  const { data } = parseFrontmatter(
    ["---", 'title: "Quoted: Title"', "description: 'single'", "---", "x"].join(
      "\n",
    ),
    "a.mdx",
  );
  assert.equal(data.title, "Quoted: Title");
  assert.equal(data.description, "single");
});

test("parseFrontmatter throws on a page without frontmatter", () => {
  // An extractor that returns a short list instead of throwing is how a
  // generated list silently loses a page (AGENTS.md § hand-maintained lists).
  assert.throws(
    () => parseFrontmatter("Just a body\n", "a.mdx"),
    /frontmatter/i,
  );
});

test("parseFrontmatter throws when title or description is missing", () => {
  assert.throws(
    () => parseFrontmatter(["---", "title: T", "---", "x"].join("\n"), "a.mdx"),
    /description/,
  );
  assert.throws(
    () =>
      parseFrontmatter(
        ["---", "description: D", "---", "x"].join("\n"),
        "a.mdx",
      ),
    /title/,
  );
});

test("parseFrontmatter names the offending file in the error", () => {
  assert.throws(
    () => parseFrontmatter("no frontmatter", "guides/oops.mdx"),
    /guides\/oops\.mdx/,
  );
});

// ── routes and sections ───────────────────────────────────────────────────

test("routeForSourcePath maps sources to the routes Starlight serves", () => {
  assert.equal(routeForSourcePath("index.mdx"), "/");
  assert.equal(routeForSourcePath("getting-started.mdx"), "/getting-started/");
  assert.equal(
    routeForSourcePath("guides/hardening.mdx"),
    "/guides/hardening/",
  );
  assert.equal(routeForSourcePath("guides/index.md"), "/guides/");
});

test("sectionForSourcePath groups by directory, root pages first", () => {
  assert.equal(sectionForSourcePath("index.mdx"), "Overview");
  assert.equal(sectionForSourcePath("installation.mdx"), "Overview");
  assert.equal(sectionForSourcePath("guides/hardening.mdx"), "Guides");
  assert.equal(sectionForSourcePath("reference/api.mdx"), "Reference");
});

test("sectionForSourcePath title-cases a multi-word directory", () => {
  // A new directory must produce its own section without anyone editing a map —
  // a hand-maintained label list is the defect this generator exists to remove.
  assert.equal(sectionForSourcePath("release-notes/v1.mdx"), "Release Notes");
});

test("sortPages puts Overview first, then sections and routes alphabetically", () => {
  const pages = [
    { route: "/reference/api/", section: "Reference" },
    { route: "/guides/b/", section: "Guides" },
    { route: "/installation/", section: "Overview" },
    { route: "/guides/a/", section: "Guides" },
    { route: "/", section: "Overview" },
  ];
  assert.deepEqual(
    sortPages(pages).map((p) => p.route),
    ["/", "/installation/", "/guides/a/", "/guides/b/", "/reference/api/"],
  );
});

// ── MDX → markdown ────────────────────────────────────────────────────────

test("mdxToMarkdown drops component imports", () => {
  const out = mdxToMarkdown(
    [
      'import { Aside, Steps } from "@astrojs/starlight/components";',
      "",
      "Real content.",
    ].join("\n"),
  );
  assert.equal(out, "Real content.");
});

test("mdxToMarkdown turns an Aside into a labelled note", () => {
  const out = mdxToMarkdown(
    [
      '<Aside type="caution" title="Shown once">',
      "",
      "The key appears once.",
      "",
      "</Aside>",
    ].join("\n"),
  );
  assert.match(out, /\*\*Caution — Shown once\*\*/);
  assert.match(out, /The key appears once\./);
  assert.doesNotMatch(out, /<Aside|<\/Aside>/);
});

test("mdxToMarkdown labels an untyped Aside as a note", () => {
  const out = mdxToMarkdown(
    ["<Aside>", "", "Body.", "", "</Aside>"].join("\n"),
  );
  assert.match(out, /\*\*Note\*\*/);
});

test("mdxToMarkdown keeps the content of Steps and Cards", () => {
  const out = mdxToMarkdown(
    [
      "<Steps>",
      "",
      "1. First",
      "2. Second",
      "",
      "</Steps>",
      "",
      "<CardGrid>",
      '  <Card title="Quick Start" icon="rocket">',
      "    Get running fast.",
      "  </Card>",
      "</CardGrid>",
    ].join("\n"),
  );
  assert.match(out, /1\. First/);
  // Flush left, both of them: four spaces in front of the body would be an
  // indented code block, and an indented `###` stops being a heading.
  assert.match(out, /^### Quick Start$/m);
  assert.match(out, /^Get running fast\.$/m);
  assert.doesNotMatch(out, /<Steps>|<Card|<CardGrid>/);
});

test("mdxToMarkdown keeps a Badge's text inline", () => {
  const out = mdxToMarkdown(
    '## Access tab <Badge text="Enterprise" variant="tip" />',
  );
  assert.equal(out, "## Access tab (Enterprise)");
});

test("mdxToMarkdown converts Starlight's ::: directives", () => {
  const out = mdxToMarkdown(
    [":::caution[Before you start]", "Back up first.", ":::"].join("\n"),
  );
  assert.match(out, /\*\*Caution — Before you start\*\*/);
  assert.match(out, /Back up first\./);
  assert.doesNotMatch(out, /:::/);
});

test("mdxToMarkdown rejects a directive Starlight does not render", () => {
  // `:::warning` is not a Starlight aside. remark-directive eats it and emits a
  // bare <div>: no colour, no icon, no label, and no error — two of them
  // shipped that way. Reading the directive here makes the failure loud for
  // free; there is no cheaper place that sees it.
  assert.throws(
    () =>
      mdxToMarkdown([":::warning", "Careful.", ":::"].join("\n"), {
        source: "guides/x.mdx",
      }),
    /guides\/x\.mdx.*:::warning.*note, tip, caution, danger/s,
  );
});

test("mdxToMarkdown leaves fenced code blocks untouched", () => {
  // A page that shows MDX or YAML in a fence must survive verbatim — stripping
  // inside a fence would rewrite the very thing the page documents.
  const source = [
    "Example:",
    "",
    "```mdx",
    '<Aside type="tip">not a real aside</Aside>',
    'import { Aside } from "@astrojs/starlight/components";',
    ":::note",
    "```",
    "",
    "Done.",
  ].join("\n");
  const out = mdxToMarkdown(source);
  assert.match(out, /<Aside type="tip">not a real aside<\/Aside>/);
  assert.match(out, /import \{ Aside \}/);
  assert.match(out, /:::note/);
  assert.match(out, /Done\./);
});

test("mdxToMarkdown closes a fence only on the same marker", () => {
  const out = mdxToMarkdown(
    ["````md", "```", '<Badge text="x" />', "````", "After"].join("\n"),
  );
  assert.match(out, /<Badge text="x" \/>/);
  assert.match(out, /After/);
});

test("mdxToMarkdown inlines a ?raw import rendered through <Code>", () => {
  // Both deploy guides render the cloud-init script this way. Dropping the tag
  // would publish a deployment guide whose actual script is missing.
  const out = mdxToMarkdown(
    [
      'import cloudInitScript from "../../../snippets/cloud-init.yml?raw";',
      "",
      '<Code code={cloudInitScript} lang="yaml" title="cloud-init.yml" />',
    ].join("\n"),
    {
      rawImports: new Map([
        ["cloudInitScript", "#cloud-config\nruncmd:\n  - echo hi"],
      ]),
    },
  );
  assert.match(out, /```yaml title="cloud-init\.yml"/);
  assert.match(out, /#cloud-config/);
});

test("mdxToMarkdown drops a <Code> whose import it could not resolve", () => {
  const out = mdxToMarkdown('<Code code={missing} lang="yaml" />', {
    rawImports: new Map(),
  });
  assert.doesNotMatch(out, /<Code/);
});

test("mdxToMarkdown drops an unknown component but keeps its children", () => {
  const out = mdxToMarkdown(
    ["<ReleasesList />", "", "<Unknown>", "Kept.", "</Unknown>"].join("\n"),
  );
  assert.doesNotMatch(out, /<ReleasesList|<Unknown>/);
  assert.match(out, /Kept\./);
});

test("mdxToMarkdown keeps a component-shaped placeholder inside inline code", () => {
  // Inline code is verbatim content, exactly like a fenced block. Stripping it
  // as if it were a component silently DELETES documentation, and no leak
  // checker can see a deletion. All three of these were live: the API
  // reference published `"at": ""` for a field that carries a timestamp.
  const out = mdxToMarkdown(
    [
      "Used for any `env.<VAR>` template.",
      "",
      'It becomes `{ "ok": false, "at": "<ISO timestamp>" }`.',
      "",
      "The bubble reads `<Agent> couldn't respond.` instead.",
    ].join("\n"),
  );
  assert.match(out, /`env\.<VAR>`/);
  assert.match(out, /"at": "<ISO timestamp>"/);
  assert.match(out, /`<Agent> couldn't respond\.`/);
});

test("mdxToMarkdown still strips a real component beside an inline code span", () => {
  // The span is preserved, not the line: a tag outside it is still a tag.
  const out = mdxToMarkdown('<Badge text="New" /> applies to `<VAR>` only.');
  assert.match(out, /\(New\) applies to `<VAR>` only\./);
});

test("mdxToMarkdown leaves lowercase HTML alone", () => {
  // <details>/<summary> are real HTML in the deploy guides, valid in markdown.
  const out = mdxToMarkdown(
    "<details>\n<summary>More</summary>\nBody\n</details>",
  );
  assert.match(out, /<details>/);
  assert.match(out, /<summary>More<\/summary>/);
});

test("mdxToMarkdown collapses the blank runs left behind by stripped tags", () => {
  const out = mdxToMarkdown(["A", "", "<Steps>", "", "B"].join("\n"));
  assert.equal(out, "A\n\nB");
});

// ── output files ──────────────────────────────────────────────────────────

const PAGES = [
  {
    route: "/",
    section: "Overview",
    title: "Pinchy Documentation",
    description: "Enterprise AI agent platform.",
    body: "Intro body.",
  },
  {
    route: "/guides/hardening/",
    section: "Guides",
    title: "Hardening Guide",
    description: "Security best practices.",
    body: "Harden it.",
  },
];

test("buildLlmsTxt writes the llmstxt.org shape", () => {
  const out = buildLlmsTxt(PAGES, {
    site: SITE,
    title: "Pinchy Documentation",
    summary: "Enterprise AI agent platform.",
    version: "v0.9.1",
  });
  const lines = out.split("\n");
  assert.equal(lines[0], "# Pinchy Documentation");
  assert.equal(lines[2], "> Enterprise AI agent platform.");
  assert.match(out, /## Overview/);
  assert.match(out, /## Guides/);
  assert.match(
    out,
    /- \[Hardening Guide\]\(https:\/\/docs\.heypinchy\.com\/guides\/hardening\/\): Security best practices\./,
  );
  assert.match(out, /v0\.9\.1/);
  assert.match(out, /llms-full\.txt/);
  assert.ok(out.endsWith("\n"));
});

test("buildLlmsTxt says the file is generated, so nobody hand-edits it again", () => {
  const out = buildLlmsTxt(PAGES, {
    site: SITE,
    title: "T",
    summary: "S",
    version: null,
  });
  assert.match(out, /generated/i);
  assert.doesNotMatch(out, /null|undefined/);
});

test("buildLlmsFullTxt carries every page's URL and body", () => {
  const out = buildLlmsFullTxt(PAGES, {
    site: SITE,
    title: "Pinchy Documentation",
    version: "v0.9.1",
  });
  assert.match(out, /^# Pinchy Documentation — Complete Reference/);
  assert.match(out, /URL: https:\/\/docs\.heypinchy\.com\/\n/);
  assert.match(
    out,
    /URL: https:\/\/docs\.heypinchy\.com\/guides\/hardening\/\n/,
  );
  assert.match(out, /Intro body\./);
  assert.match(out, /Harden it\./);
  assert.equal(out.match(/^URL: /gm).length, 2);
});

test("buildLlmsFullTxt refuses an empty page set", () => {
  // A generator that happily writes an empty file is how the published index
  // goes silently blank; the build must fail instead.
  assert.throws(
    () => buildLlmsFullTxt([], { site: SITE, title: "T", version: null }),
    /no pages/i,
  );
  assert.throws(
    () =>
      buildLlmsTxt([], { site: SITE, title: "T", summary: "S", version: null }),
    /no pages/i,
  );
});

// ── site URL ──────────────────────────────────────────────────────────────

test("readSiteUrl takes the site from the astro config", () => {
  assert.equal(
    readSiteUrl(
      'export default defineConfig({\n  site: "https://docs.heypinchy.com",\n});',
    ),
    "https://docs.heypinchy.com",
  );
});

test("readSiteUrl throws rather than guessing a default", () => {
  // Every URL in both files is built from this. A silent fallback would publish
  // an index of links to a host that is not the docs site.
  assert.throws(() => readSiteUrl("export default defineConfig({});"), /site/);
});

// ── the real corpus ───────────────────────────────────────────────────────

test("no page loses an inline code span on its way through the generator", () => {
  // The tests above pin the three shapes that were live (`env.<VAR>`,
  // `"at": "<ISO timestamp>"`, `<Agent> couldn't respond.`). This pins the
  // CLASS across every page, so the next shape fails without anyone having
  // thought of it — which is the whole point, because check-llms-txt.mjs
  // structurally cannot: a leak checker looks for what SURVIVED, and this
  // failure mode is a deletion. It reads the same corpus the build reads, so a
  // page added tomorrow is covered the day it lands.
  const pages = collectPages(CONTENT_DIR);
  assert.ok(
    pages.length > 40,
    `only ${pages.length} pages found — has the walker stopped working?`,
  );

  const lost = [];
  for (const page of pages) {
    const { body } = parseFrontmatter(
      readFileSync(join(CONTENT_DIR, page.sourcePath), "utf8"),
      page.sourcePath,
    );
    // Per line, not per body: a span that WRAPS across a source line break is
    // re-flowed on purpose (the generator dedents), and markdown renders the
    // break as a space either way. Those are the only spans this cannot speak
    // for, and `docker image prune -a\n     -f` in upgrading.mdx is the one.
    for (const line of body.split("\n")) {
      for (const span of line.match(INLINE_CODE) ?? []) {
        if (!page.body.includes(span)) lost.push(`${page.sourcePath}: ${span}`);
      }
    }
  }

  assert.deepEqual(
    lost,
    [],
    `inline code dropped from ${lost.length} place(s)`,
  );
});

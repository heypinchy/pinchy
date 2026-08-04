import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findCoverageProblems,
  findLeakedSource,
  isDocumentationPage,
  parseFullUrls,
  parseIndexUrls,
} from "./check-llms-txt.mjs";

const SITE = "https://docs.heypinchy.com";

const INDEX = [
  "# Pinchy Documentation",
  "",
  "> Summary.",
  "",
  "## Overview",
  "",
  `- [Pinchy Documentation](${SITE}/): Enterprise AI agent platform.`,
  "",
  "## Guides",
  "",
  `- [Hardening Guide](${SITE}/guides/hardening/): Security best practices.`,
].join("\n");

const FULL = [
  "# Pinchy Documentation — Complete Reference",
  `# Source: ${SITE}`,
  "",
  "# Pinchy Documentation",
  `URL: ${SITE}/`,
  "",
  "Body.",
  "",
  "---",
  "",
  "# Hardening Guide",
  `URL: ${SITE}/guides/hardening/`,
  "",
  "Body.",
].join("\n");

// ── parsing ───────────────────────────────────────────────────────────────

test("parseIndexUrls reads the routes out of the link list", () => {
  assert.deepEqual(parseIndexUrls(INDEX, SITE), ["/", "/guides/hardening/"]);
});

test("parseFullUrls reads the routes out of the URL headers", () => {
  assert.deepEqual(parseFullUrls(FULL, SITE), ["/", "/guides/hardening/"]);
});

test("parseIndexUrls throws on a file it cannot read", () => {
  // Returning [] here would report "every page is missing" — a wall of noise
  // pointing at the pages instead of at the parser that stopped working.
  assert.throws(
    () => parseIndexUrls("# Title\n\n> Summary.\n", SITE),
    /no links/i,
  );
});

test("parseFullUrls throws on a file it cannot read", () => {
  assert.throws(
    () => parseFullUrls("# Complete Reference\n", SITE),
    /no `URL:`/i,
  );
});

test("parsers reject a URL that is not on the docs site", () => {
  // A wrong `site:` would otherwise be reported as 66 missing pages.
  assert.throws(
    () => parseIndexUrls(`- [X](https://example.com/x/): d`, SITE),
    /example\.com/,
  );
});

// ── coverage, both directions ─────────────────────────────────────────────

test("findCoverageProblems is silent when both files cover every route", () => {
  assert.deepEqual(
    findCoverageProblems({
      routes: new Set(["/", "/guides/hardening/"]),
      indexUrls: ["/", "/guides/hardening/"],
      fullUrls: ["/", "/guides/hardening/"],
    }),
    [],
  );
});

test("findCoverageProblems flags a published page missing from llms.txt", () => {
  const problems = findCoverageProblems({
    routes: new Set(["/", "/guides/new/"]),
    indexUrls: ["/"],
    fullUrls: ["/", "/guides/new/"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\/guides\/new\/.*llms\.txt/);
});

test("findCoverageProblems flags a published page missing from llms-full.txt", () => {
  const problems = findCoverageProblems({
    routes: new Set(["/", "/guides/new/"]),
    indexUrls: ["/", "/guides/new/"],
    fullUrls: ["/"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /llms-full\.txt/);
});

test("findCoverageProblems flags a listed page the site does not serve", () => {
  // The worse direction, per AGENTS.md § docs coverage: an undocumented page
  // costs a reader a grep, a documented page that isn't there costs an
  // afternoon — and a crawler a 404.
  const problems = findCoverageProblems({
    routes: new Set(["/"]),
    indexUrls: ["/", "/guides/gone/"],
    fullUrls: ["/"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\/guides\/gone\/.*does not/);
});

test("findCoverageProblems flags a duplicate entry", () => {
  const problems = findCoverageProblems({
    routes: new Set(["/"]),
    indexUrls: ["/", "/"],
    fullUrls: ["/"],
  });
  assert.ok(problems.some((p) => /twice|duplicate/i.test(p)));
});

// ── what counts as a documentation page ───────────────────────────────────

test("isDocumentationPage accepts a Starlight-rendered page", () => {
  assert.equal(
    isDocumentationPage('<meta name="generator" content="Starlight v0.38.3"/>'),
    true,
  );
});

test("isDocumentationPage rejects a static file copied out of public/", () => {
  // public/installing.html is the splash a 1-click deploy shows while the
  // droplet provisions. It is served by the docs site and is not documentation.
  assert.equal(
    isDocumentationPage(
      "<!doctype html><title>Pinchy is getting ready...</title>",
    ),
    false,
  );
});

test("isDocumentationPage rejects an astro redirect stub", () => {
  assert.equal(
    isDocumentationPage(
      '<!doctype html><title>Redirecting</title><meta http-equiv="refresh" content="0;url=/guides/upgrading">',
    ),
    false,
  );
});

// ── leaked source ─────────────────────────────────────────────────────────

test("findLeakedSource flags an uninjected version placeholder", () => {
  // The generator runs inside the build's injection window. Run after the
  // restore instead, it publishes the literal placeholder to every crawler —
  // and nothing else would notice.
  const problems = findLeakedSource(
    "docker pull ghcr.io/heypinchy/pinchy:%%PINCHY_VERSION%%\n",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /%%PINCHY_VERSION%%/);
});

test("findLeakedSource flags a component tag that survived stripping", () => {
  const problems = findLeakedSource(
    ['<Aside type="tip">', "Body.", "</Aside>"].join("\n"),
  );
  assert.ok(problems.some((p) => /Aside/.test(p)));
});

test("findLeakedSource ignores tags inside fenced code", () => {
  // A page documenting MDX keeps its example verbatim — that is the generator
  // working, not failing.
  assert.deepEqual(
    findLeakedSource(
      ["```mdx", '<Aside type="tip">Example</Aside>', "```"].join("\n"),
    ),
    [],
  );
});

test("findLeakedSource ignores a tag inside an inline code span", () => {
  assert.deepEqual(
    findLeakedSource("Use the `<Agent>` element in the payload.\n"),
    [],
  );
});

test("findLeakedSource ignores ordinary HTML", () => {
  assert.deepEqual(
    findLeakedSource("<details>\n<summary>More</summary>\n</details>\n"),
    [],
  );
});

test("findLeakedSource is silent on clean text", () => {
  assert.deepEqual(findLeakedSource(`${INDEX}\n${FULL}`), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectAnchorIds,
  collectLinkHrefs,
  findBrokenLinks,
  routeForHtmlFile,
} from "./check-anchors.mjs";

// ── HTML extraction ───────────────────────────────────────────────────────

test("collectAnchorIds picks up id attributes", () => {
  const ids = collectAnchorIds(
    "<h2 id=\"reverse-proxy-with-tls\">TLS</h2><div id='sidebar'></div>",
  );
  assert.ok(ids.has("reverse-proxy-with-tls"));
  assert.ok(ids.has("sidebar"));
});

test("collectLinkHrefs picks up only anchor hrefs", () => {
  const hrefs = collectLinkHrefs(
    '<link rel="stylesheet" href="/style.css">' +
      '<a href="/guides/hardening/">Hardening</a>' +
      '<img src="/screenshots/x.png">' +
      "<a\n  class='x'\n  href='#top'>Top</a>",
  );
  assert.deepEqual(hrefs, ["/guides/hardening/", "#top"]);
});

test("collectLinkHrefs decodes HTML entities in the href", () => {
  // Astro escapes `&` in attribute values; the raw href would never match an
  // id or a file on disk.
  assert.deepEqual(collectLinkHrefs('<a href="/x/?a=1&amp;b=2">x</a>'), [
    "/x/?a=1&b=2",
  ]);
});

test("routeForHtmlFile maps index.html to its directory route", () => {
  assert.equal(
    routeForHtmlFile("guides/hardening/index.html"),
    "/guides/hardening/",
  );
  assert.equal(routeForHtmlFile("index.html"), "/");
  assert.equal(routeForHtmlFile("404.html"), "/404.html");
});

// ── Link resolution ───────────────────────────────────────────────────────

function pagesOf(spec) {
  return new Map(
    Object.entries(spec).map(([route, { ids = [], links = [] }]) => [
      route,
      { ids: new Set(ids), links },
    ]),
  );
}

test("accepts a link to an existing page and heading", () => {
  const pages = pagesOf({
    "/guides/hardening/": { ids: ["reverse-proxy-with-tls"] },
    "/security/secrets/": {
      links: ["/guides/hardening/#reverse-proxy-with-tls"],
    },
  });
  assert.deepEqual(findBrokenLinks(pages, new Set()), []);
});

test("flags a link to a heading that does not exist", () => {
  // Issue #769 itself.
  const pages = pagesOf({
    "/guides/hardening/": { ids: ["reverse-proxy-with-tls"] },
    "/security/secrets/": { links: ["/guides/hardening/#nope"] },
  });
  const problems = findBrokenLinks(pages, new Set());
  assert.equal(problems.length, 1);
  assert.equal(problems[0].route, "/security/secrets/");
  assert.equal(problems[0].href, "/guides/hardening/#nope");
  assert.match(problems[0].reason, /anchor/);
});

test("flags a same-page anchor that does not exist", () => {
  const pages = pagesOf({
    "/concepts/integrations/": { ids: ["setup-flow"], links: ["#nope"] },
  });
  const problems = findBrokenLinks(pages, new Set());
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /anchor/);
});

test("accepts a same-page anchor that exists", () => {
  const pages = pagesOf({
    "/concepts/integrations/": { ids: ["setup-flow"], links: ["#setup-flow"] },
  });
  assert.deepEqual(findBrokenLinks(pages, new Set()), []);
});

test("flags a link to a page that does not exist", () => {
  const pages = pagesOf({ "/a/": { links: ["/guides/ghost/"] } });
  const problems = findBrokenLinks(pages, new Set());
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /page/);
});

test("tolerates a missing trailing slash on a page link", () => {
  // Astro serves /guides/hardening and /guides/hardening/ alike; the check must
  // not turn a style difference into a failure.
  const pages = pagesOf({
    "/guides/hardening/": { ids: ["tls"] },
    "/a/": { links: ["/guides/hardening", "/guides/hardening#tls"] },
  });
  assert.deepEqual(findBrokenLinks(pages, new Set()), []);
});

test("ignores external, protocol-relative, mail and in-page-less links", () => {
  const pages = pagesOf({
    "/a/": {
      links: [
        "https://openclaw.ai/docs",
        "http://example.com/#whatever",
        "//cdn.example.com/x",
        "mailto:hi@heypinchy.com",
        "tel:+43123",
        "#",
        "",
      ],
    },
  });
  assert.deepEqual(findBrokenLinks(pages, new Set()), []);
});

test("accepts a link to a non-HTML file that the build emitted", () => {
  // e.g. /cloud-init.yml, generated into public/ by inject-version.sh.
  const pages = pagesOf({ "/a/": { links: ["/cloud-init.yml"] } });
  assert.deepEqual(findBrokenLinks(pages, new Set(["/cloud-init.yml"])), []);
});

test("flags a link to a file the build did not emit", () => {
  const pages = pagesOf({ "/a/": { links: ["/ghost.yml"] } });
  assert.equal(findBrokenLinks(pages, new Set()).length, 1);
});

test("resolves a relative link against the linking page", () => {
  const pages = pagesOf({
    "/guides/hardening/": { ids: ["tls"] },
    "/guides/vps-deployment/": { links: ["../hardening/#tls", "../ghost/"] },
  });
  const problems = findBrokenLinks(pages, new Set());
  assert.equal(problems.length, 1);
  assert.equal(problems[0].href, "../ghost/");
});

test("resolves a relative link from a page that is a file, not a directory", () => {
  // /404.html is the one route that is a file. Resolving against it directly
  // would invent a /404.html/… path and report a false break.
  const pages = pagesOf({
    "/getting-started/": { ids: ["install"] },
    "/404.html": { links: ["getting-started/#install"] },
  });
  assert.deepEqual(findBrokenLinks(pages, new Set()), []);
});

test("strips a query string before resolving", () => {
  const pages = pagesOf({
    "/": { ids: ["x"] },
    "/a/": { links: ["/?search=foo", "/?search=foo#x"] },
  });
  assert.deepEqual(findBrokenLinks(pages, new Set()), []);
});

test("decodes a percent-encoded fragment before matching an id", () => {
  const pages = pagesOf({
    "/a/": { ids: ["über-uns"], links: ["#%C3%BCber-uns"] },
  });
  assert.deepEqual(findBrokenLinks(pages, new Set()), []);
});

test("reports each distinct broken link once per page", () => {
  // Starlight repeats the sidebar on every page; without de-duplication one
  // broken nav entry would produce 69 identical findings.
  const pages = pagesOf({
    "/a/": { links: ["/ghost/", "/ghost/"] },
    "/b/": { links: ["/ghost/"] },
  });
  const problems = findBrokenLinks(pages, new Set());
  assert.equal(problems.length, 2);
  assert.deepEqual(
    problems.map((p) => p.route),
    ["/a/", "/b/"],
  );
});

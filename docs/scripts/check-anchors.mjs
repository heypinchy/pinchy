import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Validates internal links and in-page anchors in the BUILT docs site (#769).
 *
 * Why the built output and not the `.mdx` source: in the source, a link like
 * `/guides/hardening/#reverse-proxy-with-tls` is a route into the generated
 * site, not a file on disk — which is exactly why the `links` job (lychee)
 * passes `--exclude-path docs`. `docs/dist/` is where the routes and the real
 * `id="…"` attributes both exist, so it is the only place the two halves of
 * such a link can be resolved against each other.
 *
 * This also follows AGENTS.md's own rule from the X-Frame-Options gate: assert
 * what a concrete URL resolves to, not what a source file asked for.
 *
 * Run with `pnpm -C docs check:anchors` AFTER `pnpm -C docs build`.
 */

const DIST_DIR = join(fileURLToPath(import.meta.url), "../../dist");

/** Matches `id="…"` / `id='…'` on any element. */
const ID_ATTRIBUTE = /\sid=("([^"]*)"|'([^']*)')/g;

/** Matches the `href` of an `<a>` element, across newlines and other attributes. */
const ANCHOR_HREF = /<a\s[^>]*?href=("([^"]*)"|'([^']*)')/gis;

/** Schemes and protocol-relative URLs we never resolve locally. */
const EXTERNAL = /^([a-z][a-z0-9+.\-]*:|\/\/)/i;

/**
 * @param {string} html
 * @returns {Set<string>} every id attribute value on the page
 */
export function collectAnchorIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(ID_ATTRIBUTE)) {
    ids.add(decodeEntities(match[2] ?? match[3] ?? ""));
  }
  return ids;
}

/**
 * @param {string} html
 * @returns {string[]} every `<a href>` value on the page, in document order
 */
export function collectLinkHrefs(html) {
  const hrefs = [];
  for (const match of html.matchAll(ANCHOR_HREF)) {
    hrefs.push(decodeEntities(match[2] ?? match[3] ?? ""));
  }
  return hrefs;
}

/**
 * @param {string} relativePath path of an .html file below dist/, posix-style
 * @returns {string} the site route it is served at
 */
export function routeForHtmlFile(relativePath) {
  if (relativePath === "index.html") return "/";
  if (relativePath.endsWith("/index.html")) {
    return `/${relativePath.slice(0, -"index.html".length)}`;
  }
  return `/${relativePath}`;
}

/**
 * @param {Map<string, { ids: Set<string>, links: string[] }>} pages route -> page data
 * @param {Set<string>} assets site paths of non-HTML files the build emitted
 * @returns {Array<{ route: string, href: string, reason: string }>}
 */
export function findBrokenLinks(pages, assets) {
  const problems = [];

  for (const [route, page] of pages) {
    const seen = new Set();

    for (const href of page.links) {
      if (href === "" || href === "#" || EXTERNAL.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const [beforeHash, ...hashParts] = href.split("#");
      const hash = decodeFragment(hashParts.join("#"));
      const path = beforeHash.split("?")[0];

      // A bare `#fragment` stays on the linking page.
      const target = path === "" ? route : resolve(route, path);

      if (assets.has(target) || assets.has(stripTrailingSlash(target)))
        continue;

      const targetPage =
        pages.get(target) ?? pages.get(ensureTrailingSlash(target));
      if (!targetPage) {
        problems.push({
          route,
          href,
          reason: "links to a page that does not exist",
        });
        continue;
      }
      if (hash && !targetPage.ids.has(hash)) {
        problems.push({
          route,
          href,
          reason: "links to an anchor that does not exist",
        });
      }
    }
  }

  return problems;
}

function resolve(fromRoute, path) {
  // A relative href resolves against the linking page's DIRECTORY. For the
  // routes Starlight emits that is the route itself, but `/404.html` is a file,
  // and resolving against it would invent a `/404.html/…` path.
  const baseDir = fromRoute.endsWith("/")
    ? fromRoute
    : `${posix.dirname(fromRoute)}/`;
  // `posix.resolve` handles an absolute `path` too, and normalizes `..` in it —
  // which a special case for absolute paths would skip, turning a link that a
  // browser follows fine into a red build.
  const absolute = posix.resolve(baseDir, path);
  // Extensionless routes are directories; Astro serves them with or without the
  // trailing slash, so normalize to the form dist/ produces. A route whose last
  // segment does contain a dot (/upgrade-notes/v0.5.0/ is one) is caught by the
  // caller's trailing-slash fallback instead.
  return posix.basename(absolute).includes(".")
    ? absolute
    : ensureTrailingSlash(absolute);
}

function ensureTrailingSlash(path) {
  return path.endsWith("/") ? path : `${path}/`;
}

function stripTrailingSlash(path) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function decodeFragment(hash) {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

function walk(dir, base = dir) {
  const html = [];
  const other = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = walk(full, base);
      html.push(...nested.html);
      other.push(...nested.other);
    } else {
      const rel = relative(base, full).split(/[\\/]/).join("/");
      (rel.endsWith(".html") ? html : other).push(rel);
    }
  }
  return { html, other };
}

/**
 * @param {string} distDir a built site's output directory
 * @returns {{ pages: Map<string, { ids: Set<string>, links: string[] }>, assets: Set<string> }}
 */
export function collectSite(distDir) {
  const entries = walk(distDir);

  const pages = new Map();
  for (const file of entries.html) {
    const html = readFileSync(join(distDir, file), "utf8");
    pages.set(routeForHtmlFile(file), {
      ids: collectAnchorIds(html),
      links: collectLinkHrefs(html),
    });
  }
  return {
    pages,
    assets: new Set(entries.other.map((file) => `/${file}`)),
  };
}

function main() {
  let site;
  try {
    site = collectSite(DIST_DIR);
  } catch (err) {
    // Only a missing dist/ means "you forgot to build". Anything else (a
    // permission error, an unreadable file mid-walk) must say what it was —
    // printing the build hint for every failure sends the reader to fix a
    // thing that is not broken.
    console.error(
      err?.code === "ENOENT"
        ? "❌ docs/dist/ not found — run `pnpm -C docs build` before `check:anchors`."
        : `❌ could not read docs/dist/: ${err?.message ?? err}`,
    );
    process.exit(1);
  }

  const { pages, assets } = site;

  // A gate reports on what it looked at, not on what it should have. Without
  // this, a changed `outDir` or a build that emitted nothing prints
  // "✅ 0 pages checked" and passes — green against no evidence at all.
  if (pages.size === 0) {
    console.error(
      "❌ docs/dist/ contains no HTML pages — nothing was checked.\n" +
        "   Run `pnpm -C docs build` first, or check astro's `outDir`.",
    );
    process.exit(1);
  }

  const problems = findBrokenLinks(pages, assets);

  if (problems.length === 0) {
    console.log(`✅ ${pages.size} pages checked, no broken internal links.`);
    return;
  }

  console.error(
    `❌ ${problems.length} broken internal link(s) in the built docs:\n`,
  );
  for (const { route, href, reason } of problems) {
    console.error(`   ${route}\n     ${href} — ${reason}`);
  }
  console.error(
    "\nThe anchors are the headings' generated ids: lowercase, spaces to '-',\n" +
      "punctuation dropped. Check the target page's headings, or the page path.",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

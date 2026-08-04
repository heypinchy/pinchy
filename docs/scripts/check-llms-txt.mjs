import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { routeForHtmlFile } from "./check-anchors.mjs";
import { readSiteUrl } from "./generate-llms-txt.mjs";

/**
 * Checks the generated `dist/llms.txt` and `dist/llms-full.txt` against the
 * site that was actually built (#1080).
 *
 * `generate-llms-txt.mjs` derives both files from `src/content/docs`. This
 * reads them back against `dist/`, so the claim being checked is the one that
 * matters: every page docs.heypinchy.com serves is in the index an AI crawler
 * fetches, and every entry in that index is a page the site really serves.
 * Same rule as the X-Frame-Options gate in AGENTS.md — assert what a concrete
 * URL resolves to, not what a source file asked for.
 *
 * Both directions are checked, and the second one is the worse: an
 * undocumented page costs a crawler nothing, an indexed page that 404s costs
 * it the trust in the whole index.
 *
 * Run with `pnpm -C docs check:llms` AFTER `pnpm -C docs build`.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(SCRIPT_DIR, "..");
const DIST_DIR = join(DOCS_DIR, "dist");
const ASTRO_CONFIG = join(DOCS_DIR, "astro.config.mjs");

/**
 * The site has 66 content pages. A floor well below that catches the failure a
 * coverage gate cannot otherwise see: a walker that stopped finding anything
 * reports "0 problems" and passes, green against no evidence at all.
 */
const MINIMUM_ROUTES = 20;

/** `- [Title](https://…/route/): description` */
const INDEX_LINK = /^-\s+\[[^\]]*\]\(([^)]+)\)/gm;

/** `URL: https://…/route/` */
const FULL_URL = /^URL:\s*(\S+)\s*$/gm;

/**
 * Every page Starlight renders stamps its own generator meta. Nothing else in
 * dist/ does — not the static files copied out of `public/` (`installing.html`
 * is the provisioning splash a 1-click deploy shows), and not the meta-refresh
 * stubs astro emits for each `redirects:` entry. That marker is therefore the
 * precise definition of the corpus these files mirror: documentation pages,
 * not "every .html the build happened to emit".
 */
const STARLIGHT_PAGE = /name=["']generator["']\s+content=["']Starlight/i;

const PLACEHOLDER = /%%PINCHY_VERSION%%/;

/** Opens or closes a fenced code block. */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * A JSX component tag that survived the MDX stripping. Deliberately requires
 * CamelCase (an uppercase letter followed by a lowercase one): the pages write
 * placeholders like `<VAR>` and `<ISO timestamp>` in prose, and those are not
 * components. Inline code is stripped before this runs, which is where all of
 * today's `<Agent>`-shaped examples live.
 */
const JSX_TAG = /<\/?([A-Z][a-z][A-Za-z0-9]*)(\s[^>]*)?\/?>/;

function toPath(url, site, where) {
  if (!url.startsWith(site)) {
    throw new Error(
      `${where} links to ${url}, which is not on ${site} — check astro.config.mjs's \`site:\``,
    );
  }
  const path = url.slice(site.length);
  return path === "" ? "/" : path;
}

/**
 * @param {string} text contents of llms.txt
 * @param {string} site canonical origin, no trailing slash
 * @returns {string[]} the routes it lists, in file order
 */
export function parseIndexUrls(text, site) {
  const urls = [...text.matchAll(INDEX_LINK)].map((m) =>
    toPath(m[1], site, "llms.txt"),
  );
  if (urls.length === 0) {
    // Never []: that would report every page as missing, sending the reader to
    // the pages instead of to the parser that stopped matching.
    throw new Error(
      "llms.txt has no links — the file or this parser is broken",
    );
  }
  return urls;
}

/**
 * @param {string} text contents of llms-full.txt
 * @param {string} site canonical origin, no trailing slash
 * @returns {string[]} the routes it carries, in file order
 */
export function parseFullUrls(text, site) {
  const urls = [...text.matchAll(FULL_URL)].map((m) =>
    toPath(m[1], site, "llms-full.txt"),
  );
  if (urls.length === 0) {
    throw new Error(
      "llms-full.txt has no `URL:` headers — the file or this parser is broken",
    );
  }
  return urls;
}

/**
 * @param {string} html a built .html file
 * @returns {boolean} true when Starlight rendered it, i.e. it is a docs page
 */
export function isDocumentationPage(html) {
  return STARLIGHT_PAGE.test(html);
}

/**
 * @param {{ routes: Set<string>, indexUrls: string[], fullUrls: string[] }} input
 * @returns {string[]} problems (empty = ok)
 */
export function findCoverageProblems({ routes, indexUrls, fullUrls }) {
  const problems = [];

  for (const [file, urls] of [
    ["llms.txt", indexUrls],
    ["llms-full.txt", fullUrls],
  ]) {
    const seen = new Set();
    for (const url of urls) {
      if (seen.has(url)) {
        problems.push(`${file} lists ${url} twice`);
      }
      seen.add(url);
      if (!routes.has(url)) {
        problems.push(
          `${file} lists ${url}, which the built site does not serve`,
        );
      }
    }
    for (const route of routes) {
      if (!seen.has(route)) {
        problems.push(`${route} is published but missing from ${file}`);
      }
    }
  }

  return problems;
}

/**
 * @param {string} text a generated file
 * @returns {string[]} problems (empty = ok)
 */
export function findLeakedSource(text) {
  const problems = [];
  let fence = null;

  text.split("\n").forEach((line, index) => {
    const at = `line ${index + 1}`;

    if (PLACEHOLDER.test(line)) {
      // The generator runs inside the build's version-injection window. Moved
      // outside it, it publishes the literal placeholder — in install commands.
      problems.push(
        `${at}: %%PINCHY_VERSION%% was never injected — ${line.trim()}`,
      );
    }

    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null;
      }
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return;
    }

    // Inline code carries the pages' `<Agent>`-shaped prose examples, which are
    // documentation, not leftovers.
    const prose = line.replace(/`[^`]*`/g, "");
    const tag = JSX_TAG.exec(prose);
    if (tag) {
      problems.push(
        `${at}: <${tag[1]}> survived MDX stripping — teach generate-llms-txt.mjs about it`,
      );
    }
  });

  return problems;
}

function walkHtml(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkHtml(full, base));
    } else if (entry.endsWith(".html")) {
      files.push(relative(base, full).split(/[\\/]/).join("/"));
    }
  }
  return files;
}

/**
 * @param {string} distDir
 * @returns {Set<string>} routes of the pages the site actually serves
 */
export function collectContentRoutes(distDir) {
  const routes = new Set();
  for (const file of walkHtml(distDir)) {
    const route = routeForHtmlFile(file);
    // Starlight renders the 404 page too, but a status page is not something a
    // crawler should be handed as documentation.
    if (route === "/404.html") continue;
    if (!isDocumentationPage(readFileSync(join(distDir, file), "utf8")))
      continue;
    routes.add(route);
  }
  return routes;
}

function main() {
  const site = readSiteUrl(readFileSync(ASTRO_CONFIG, "utf8"));

  let index;
  let full;
  let routes;
  try {
    index = readFileSync(join(DIST_DIR, "llms.txt"), "utf8");
    full = readFileSync(join(DIST_DIR, "llms-full.txt"), "utf8");
    routes = collectContentRoutes(DIST_DIR);
  } catch (err) {
    console.error(
      err?.code === "ENOENT"
        ? `❌ ${err.path ?? "docs/dist/"} not found — run \`pnpm -C docs build\` before \`check:llms\`.`
        : `❌ could not read docs/dist/: ${err?.message ?? err}`,
    );
    process.exit(1);
  }

  if (routes.size < MINIMUM_ROUTES) {
    console.error(
      `❌ docs/dist/ has only ${routes.size} content pages (expected at least ${MINIMUM_ROUTES}).\n` +
        "   Either the build emitted almost nothing, or this walker stopped finding pages.",
    );
    process.exit(1);
  }

  let problems;
  try {
    problems = [
      ...findCoverageProblems({
        routes,
        indexUrls: parseIndexUrls(index, site),
        fullUrls: parseFullUrls(full, site),
      }),
      ...findLeakedSource(index),
      ...findLeakedSource(full),
    ];
  } catch (err) {
    console.error(`❌ ${err?.message ?? err}`);
    process.exit(1);
  }

  if (problems.length === 0) {
    console.log(
      `✅ llms.txt and llms-full.txt cover all ${routes.size} published pages.`,
    );
    return;
  }

  console.error(
    `❌ ${problems.length} problem(s) in the generated llms files:\n`,
  );
  for (const problem of problems) console.error(`   ${problem}`);
  console.error(
    "\nBoth files are generated by scripts/generate-llms-txt.mjs during the build.\n" +
      "Do not edit them — fix the generator, or the page's frontmatter.",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

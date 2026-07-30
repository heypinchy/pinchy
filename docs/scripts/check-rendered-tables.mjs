import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fails if the BUILT docs site ships markdown table syntax as text.
 *
 * This exists because it happened, live: astro@6 deprecated `markdown.gfm` and
 * leaves it undefined, `.md` falls back to the default (`true`) while
 * @astrojs/mdx@5 reads `config.markdown.gfm` and got `undefined` — so every
 * `.mdx` page lost remark-gfm and every table on docs.heypinchy.com rendered as
 * a paragraph of `|` characters. 41 of 69 pages. Nothing was red: the astro
 * build succeeded, prettier was happy (it sees a paragraph, and formats it as
 * one), and the anchor checker passed because links and ids were all fine.
 *
 * Same rule as the anchor check next to it: assert what the built page actually
 * contains, not what the source file asked for. The check is deliberately about
 * the SYMPTOM rather than the config — the next way to lose gfm will not look
 * like this one, but it will look like this in dist/.
 *
 * Run with `pnpm -C docs check:rendered` AFTER `pnpm -C docs build`.
 */

const DIST_DIR = join(fileURLToPath(import.meta.url), "../../dist");

/** Strip script/style wholesale — their contents are never page prose. */
const DROPPED_ELEMENTS = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** A `<pre>` block is code: a shell pipe there is a pipe, not a table. */
const CODE_BLOCKS = /<pre\b[^>]*>[\s\S]*?<\/pre>/gi;
const TAGS = /<[^>]+>/g;

/**
 * A markdown table row that survived into the text: a line that both starts and
 * ends with `|`. Prose that merely contains a pipe (`a | b`) does not match,
 * which is what keeps this check quiet on the pages that legitimately use one.
 */
const TABLE_LINE = /^\|.*\|$/;

/**
 * @param {string} html
 * @returns {string} the page's visible text, tags and entities resolved
 */
export function collectPageText(html) {
  return html
    .replace(DROPPED_ELEMENTS, " ")
    .replace(CODE_BLOCKS, " ")
    .replace(TAGS, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function walk(dir, base = dir) {
  const html = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      html.push(...walk(full, base));
    } else if (entry.endsWith(".html")) {
      html.push(relative(base, full).split(/[\\/]/).join("/"));
    }
  }
  return html;
}

function routeForHtmlFile(relativePath) {
  if (relativePath === "index.html") return "/";
  if (relativePath.endsWith("/index.html")) {
    return `/${relativePath.slice(0, -"index.html".length)}`;
  }
  return `/${relativePath}`;
}

/**
 * @param {string} distDir a built site's output directory
 * @returns {Array<{ route: string, sample: string }>} one entry per affected page
 */
export function findUnrenderedMarkup(distDir) {
  const problems = [];

  for (const file of walk(distDir)) {
    const text = collectPageText(readFileSync(join(distDir, file), "utf8"));
    const offender = text
      .split("\n")
      .find((line) => TABLE_LINE.test(line) && line.length > 2);
    if (offender !== undefined) {
      problems.push({
        route: routeForHtmlFile(file),
        sample: offender.slice(0, 100),
      });
    }
  }

  return problems;
}

function main() {
  let pages;
  let problems;
  try {
    pages = walk(DIST_DIR);
    problems = findUnrenderedMarkup(DIST_DIR);
  } catch (err) {
    console.error(
      err?.code === "ENOENT"
        ? "❌ docs/dist/ not found — run `pnpm -C docs build` before `check:rendered`."
        : `❌ could not read docs/dist/: ${err?.message ?? err}`,
    );
    process.exit(1);
  }

  // Same reason as the anchor check: "✅ 0 pages checked" against an empty or
  // relocated dist/ is a green light earned by looking at nothing.
  if (pages.length === 0) {
    console.error(
      "❌ docs/dist/ contains no HTML pages — nothing was checked.\n" +
        "   Run `pnpm -C docs build` first, or check astro's `outDir`.",
    );
    process.exit(1);
  }

  if (problems.length === 0) {
    console.log(`✅ ${pages.length} pages checked, every table rendered.`);
    return;
  }

  console.error(
    `❌ ${problems.length} page(s) ship markdown table syntax as text:\n`,
  );
  for (const { route, sample } of problems) {
    console.error(`   ${route}\n     ${sample}`);
  }
  console.error(
    "\nThe tables did not render. Check `markdown.gfm` in docs/astro.config.mjs —\n" +
      "@astrojs/mdx reads that option, and without it .mdx tables become paragraphs.",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

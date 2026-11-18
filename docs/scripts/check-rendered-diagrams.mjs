import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { routeForHtmlFile } from "./check-anchors.mjs";

/**
 * Fails if the BUILT docs site ships a Mermaid diagram as a code block.
 *
 * This exists because the astro 7 upgrade (#851) did exactly that on its first
 * try: @pasqal-io/starlight-client-mermaid registered its remark plugin through
 * `markdown.remarkPlugins`, which astro 7's default Markdown processor (Sätteri)
 * never runs. The build succeeded, check:anchors / check:rendered / check:llms
 * were all green, and the architecture page showed its diagram as a block of
 * raw Mermaid source.
 *
 * Same rule as check:rendered next to it: assert what the built page contains,
 * not what the config asked for. Two directions, because they fail differently:
 *   - a code block whose language is `mermaid` is the symptom above;
 *   - a page with fewer diagram containers than its source has ```mermaid
 *     fences is a renderer that dropped the block instead of rendering it — no
 *     code block to flag, so the first half alone would read that as success.
 *     Compared per page, not site-wide: a surplus on one page must not hide a
 *     drop on another.
 *
 * Run with `pnpm -C docs check:diagrams` AFTER `pnpm -C docs build`.
 */

const SCRIPT_DIR = join(fileURLToPath(import.meta.url), "..");
const DIST_DIR = join(SCRIPT_DIR, "../dist");
const CONTENT_DIR = join(SCRIPT_DIR, "../src/content/docs");

/**
 * A code block that declares mermaid as its language, in the markup of every
 * renderer astro has shipped: Expressive Code and Shiki put it on
 * `data-language`, Prism and bare remark-rehype on a `language-mermaid` class.
 */
const MERMAID_CODE_BLOCK =
  /<(?:pre|code)\b[^>]*(?:data-language=["']?mermaid\b|class=["'][^"']*\blanguage-mermaid\b)/i;

/** What `src/integrations/mermaid/index.mjs` emits for each diagram. */
const DIAGRAM_CONTAINER = /<div\b[^>]*\bclass=["']mermaid["']/gi;

function walk(dir, extensions, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full, extensions, base));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      files.push(relative(base, full).split(/[\\/]/).join("/"));
    }
  }
  return files;
}

/**
 * One pass over the built site.
 *
 * @param {string} distDir a built site's output directory
 * @returns {{ pages: number, codeRoutes: string[], containers: Map<string, number> }}
 *   HTML pages read, routes shipping a diagram as code, and diagram containers per route
 */
export function collectBuiltDiagrams(distDir) {
  const files = walk(distDir, [".html"]);
  const codeRoutes = [];
  const containers = new Map();
  for (const file of files) {
    const html = readFileSync(join(distDir, file), "utf8");
    const route = routeForHtmlFile(file);
    if (MERMAID_CODE_BLOCK.test(html)) codeRoutes.push(route);
    const count = html.match(DIAGRAM_CONTAINER)?.length ?? 0;
    if (count > 0) containers.set(route, count);
  }
  return { pages: files.length, codeRoutes, containers };
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/**
 * Counts the ```mermaid fences that render. Three things do not:
 *   - a fence quoted inside a longer fence — an example of the syntax, code on
 *     purpose (a closing fence uses the opening character, at least as often);
 *   - in `.md`, a fence indented 4+ spaces, which CommonMark reads as indented
 *     code. MDX disables indented code, so there it is still a fence;
 *   - a fence inside a comment (`{/* … *\/}` in MDX, `<!-- … -->` in `.md`).
 *
 * @param {string} text a page's source
 * @param {{ mdx: boolean }} options
 * @returns {number}
 */
export function countMermaidFencesIn(text, { mdx }) {
  const [commentStart, commentEnd] = mdx ? ["{/*", "*/}"] : ["<!--", "-->"];
  let count = 0;
  let open = null;
  let inComment = false;
  for (const line of text.split("\n")) {
    if (inComment) {
      if (line.includes(commentEnd)) inComment = false;
      continue;
    }
    const match = FENCE.exec(line);
    if (open !== null) {
      const [, , fence, info] = match ?? [];
      if (
        match &&
        fence[0] === open[0] &&
        fence.length >= open.length &&
        info === ""
      ) {
        open = null;
      }
      continue;
    }
    if (match && (mdx || /^ {0,3}$/.test(match[1]))) {
      open = match[2];
      if (match[3] === "mermaid") count += 1;
      continue;
    }
    const start = line.indexOf(commentStart);
    if (
      start !== -1 &&
      !line.includes(commentEnd, start + commentStart.length)
    ) {
      inComment = true;
    }
  }
  return count;
}

/**
 * The route Starlight serves a content file at: a frontmatter `slug` wins,
 * otherwise the lowercased path without its extension, `index` dropped.
 *
 * @param {string} relativePath posix path below the content collection
 * @param {string} text the file's source
 * @returns {string}
 */
export function routeForSourceFile(relativePath, text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const slug = /^slug:[ \t]*["']?([^"'\r\n]*?)["']?[ \t]*$/m.exec(
    frontmatter,
  )?.[1];
  const path =
    slug ??
    relativePath
      .replace(/\.mdx?$/, "")
      .replace(/(?:^|\/)index$/, "")
      .toLowerCase();
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : `/${trimmed}/`;
}

/**
 * @param {string} contentDir the docs content collection
 * @returns {Map<string, number>} route -> rendering ```mermaid fences
 */
export function mermaidFencesByRoute(contentDir) {
  const fences = new Map();
  for (const file of walk(contentDir, [".md", ".mdx"])) {
    const text = readFileSync(join(contentDir, file), "utf8");
    const count = countMermaidFencesIn(text, { mdx: file.endsWith(".mdx") });
    if (count > 0) fences.set(routeForSourceFile(file, text), count);
  }
  return fences;
}

/**
 * @param {Map<string, number>} fences route -> ```mermaid fences in the source
 * @param {Map<string, number>} containers route -> diagram containers built
 * @returns {Array<{ route: string, fences: number, containers: number }>}
 */
export function findDroppedDiagrams(fences, containers) {
  const dropped = [];
  for (const [route, expected] of fences) {
    const built = containers.get(route) ?? 0;
    if (built < expected) {
      dropped.push({ route, fences: expected, containers: built });
    }
  }
  return dropped;
}

function readOrExit(read, notFound, what) {
  try {
    return read();
  } catch (err) {
    console.error(
      err?.code === "ENOENT"
        ? `❌ ${notFound}`
        : `❌ could not read ${what}: ${err?.message ?? err}`,
    );
    process.exit(1);
  }
}

function main() {
  const built = readOrExit(
    () => collectBuiltDiagrams(DIST_DIR),
    "docs/dist/ not found — run `pnpm -C docs build` before `check:diagrams`.",
    "docs/dist/",
  );
  const fences = readOrExit(
    () => mermaidFencesByRoute(CONTENT_DIR),
    "docs/src/content/docs/ not found — CONTENT_DIR in this script no longer points at the docs collection.",
    "docs/src/content/docs/",
  );

  if (built.pages === 0) {
    console.error(
      "❌ docs/dist/ contains no HTML pages — nothing was checked.\n" +
        "   Run `pnpm -C docs build` first, or check astro's `outDir`.",
    );
    process.exit(1);
  }

  const failures = [];
  if (built.codeRoutes.length > 0) {
    failures.push(
      `${built.codeRoutes.length} page(s) ship a Mermaid diagram as a code block:\n` +
        built.codeRoutes.map((route) => `   ${route}`).join("\n"),
    );
  }
  const dropped = findDroppedDiagrams(fences, built.containers);
  if (dropped.length > 0) {
    failures.push(
      `${dropped.length} page(s) render fewer diagrams than their source has \`\`\`mermaid blocks:\n` +
        dropped
          .map(
            ({ route, fences: f, containers: c }) =>
              `   ${route} (${f} block(s), ${c} diagram(s))`,
          )
          .join("\n"),
    );
  }

  const total = [...fences.values()].reduce((sum, n) => sum + n, 0);
  if (failures.length === 0) {
    console.log(
      `✅ ${built.pages} pages checked; ${total} Mermaid block(s) in the source, all rendered as diagrams.`,
    );
    return;
  }

  for (const failure of failures) console.error(`❌ ${failure}`);
  console.error(
    "\nThe diagrams did not render. Check src/integrations/mermaid/index.mjs — it must\n" +
      "register its transform on `markdown.processor`, the pipeline astro 7 runs.",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

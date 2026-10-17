import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
 *   - fewer diagram containers than ```mermaid fences in the source is a
 *     renderer that dropped the block instead of rendering it — no code block
 *     to flag, so the first half alone would read that as success.
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

/** What `src/integrations/mermaid.mjs` emits for each diagram. */
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

function routeForHtmlFile(relativePath) {
  if (relativePath === "index.html") return "/";
  if (relativePath.endsWith("/index.html")) {
    return `/${relativePath.slice(0, -"index.html".length)}`;
  }
  return `/${relativePath}`;
}

/**
 * @param {string} distDir a built site's output directory
 * @returns {Array<{ route: string }>} one entry per page shipping a diagram as code
 */
export function findDiagramsShippedAsCode(distDir) {
  return walk(distDir, [".html"])
    .filter((file) =>
      MERMAID_CODE_BLOCK.test(readFileSync(join(distDir, file), "utf8")),
    )
    .map((file) => ({ route: routeForHtmlFile(file) }));
}

/**
 * @param {string} distDir a built site's output directory
 * @returns {number} rendered diagram containers across every page
 */
export function countDiagramContainers(distDir) {
  let count = 0;
  for (const file of walk(distDir, [".html"])) {
    const html = readFileSync(join(distDir, file), "utf8");
    count += html.match(DIAGRAM_CONTAINER)?.length ?? 0;
  }
  return count;
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/**
 * Counts top-level ```mermaid fences. A fence quoted inside a longer fence is
 * an example of the syntax and renders as code on purpose, so it is skipped:
 * a closing fence must use the opening character, at least as many times.
 *
 * @param {string} contentDir the docs content collection
 * @returns {number}
 */
export function countMermaidFences(contentDir) {
  let count = 0;
  for (const file of walk(contentDir, [".md", ".mdx"])) {
    let open = null;
    for (const line of readFileSync(join(contentDir, file), "utf8").split(
      "\n",
    )) {
      const match = FENCE_OPEN.exec(line);
      if (!match) continue;
      const [, fence, info] = match;
      if (open === null) {
        open = fence;
        if (info === "mermaid") count += 1;
      } else if (
        fence[0] === open[0] &&
        fence.length >= open.length &&
        info === ""
      ) {
        open = null;
      }
    }
  }
  return count;
}

function main() {
  let problems;
  let containers;
  let fences;
  try {
    problems = findDiagramsShippedAsCode(DIST_DIR);
    containers = countDiagramContainers(DIST_DIR);
    fences = countMermaidFences(CONTENT_DIR);
  } catch (err) {
    console.error(
      err?.code === "ENOENT"
        ? "❌ docs/dist/ not found — run `pnpm -C docs build` before `check:diagrams`."
        : `❌ could not read docs/dist/: ${err?.message ?? err}`,
    );
    process.exit(1);
  }

  const failures = [];
  if (problems.length > 0) {
    failures.push(
      `${problems.length} page(s) ship a Mermaid diagram as a code block:\n` +
        problems.map(({ route }) => `   ${route}`).join("\n"),
    );
  }
  if (containers < fences) {
    failures.push(
      `the source has ${fences} \`\`\`mermaid block(s), the built site renders ${containers} diagram(s).`,
    );
  }

  if (failures.length === 0) {
    console.log(
      `✅ ${fences} Mermaid block(s) in the source, ${containers} rendered as diagrams.`,
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

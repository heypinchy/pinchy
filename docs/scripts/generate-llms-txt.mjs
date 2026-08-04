import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates `dist/llms.txt` and `dist/llms-full.txt` from the docs source (#1080).
 *
 * Both files are served to AI crawlers from docs.heypinchy.com, and both used
 * to be hand-written and committed under `public/`. They rotted exactly the way
 * AGENTS.md § "A Hand-Maintained List That Mirrors Code Will Be Wrong"
 * predicts: on 2026-08-04 the index listed 12 of 66 pages, the full text
 * carried 9, and what it carried described April-era Pinchy — "Auth.js" for an
 * app that moved to Better Auth, dev database port 5433 for a stack that binds
 * 5434, and not one mention of IMAP or the knowledge base. Nothing was red,
 * because nothing read them.
 *
 * The control group is `contracts.tools`: the one mirrored list with a
 * generator/guard behind it is the one that stayed correct. So these are
 * generated, never edited — a page added to `src/content/docs/` appears in both
 * files on the next build, and `check-llms-txt.mjs` fails the build if it
 * does not.
 *
 * Runs INSIDE the build (after `astro build`, before the placeholder restore),
 * for two reasons: `dist/` has to exist to write into, and the source tree
 * still carries the injected `%%PINCHY_VERSION%%` values at that point. Run
 * afterwards it would publish the literal placeholder to every crawler.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(SCRIPT_DIR, "..");
const CONTENT_DIR = join(DOCS_DIR, "src", "content", "docs");
const DIST_DIR = join(DOCS_DIR, "dist");
const ASTRO_CONFIG = join(DOCS_DIR, "astro.config.mjs");
const INJECTED_VERSION = join(DOCS_DIR, ".injected-version");

/** Opens (or closes) a fenced code block: ``` or ~~~, three or more. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** A component import — `import { Aside } from "…"` — never part of the prose. */
const IMPORT_LINE = /^\s*import\s+[^;]+\s+from\s+["'][^"']+["'];?\s*$/;

/** `import ident from "…?raw"` — the file's text, inlined by a <Code> tag. */
const RAW_IMPORT = /^\s*import\s+(\w+)\s+from\s+["']([^"']+\?raw)["'];?\s*$/;

/** A self-closing `<Code code={ident} lang="…" title="…" />`. */
const CODE_TAG = /^(\s*)<Code\s+([^>]*?)\/>\s*$/;

/** Any JSX component tag — capitalized, unlike the real HTML the pages use. */
const COMPONENT_TAG = /<(\/?)([A-Z][A-Za-z0-9]*)\b([^>]*?)(\/?)>/g;

/** Starlight's markdown aside: `:::caution[Title]` … `:::`. */
const DIRECTIVE_OPEN = /^:::+(\w+)(?:\[([^\]]*)\])?\s*$/;
const DIRECTIVE_CLOSE = /^:::+\s*$/;

/**
 * The only aside types Starlight renders. Anything else is consumed by
 * remark-directive and emitted as a bare `<div>`: no colour, no icon, no
 * label, and no error anywhere. Two `:::warning` blocks shipped that way on
 * docs.heypinchy.com. Since this generator has to read the directive anyway,
 * it is the cheapest place to make that failure loud.
 */
const ASIDE_TYPES = new Set(["note", "tip", "caution", "danger"]);

/**
 * Reads one `key: value` out of an attribute string (`type="tip" title="X"`).
 * @param {string} attrs
 * @param {string} name
 * @returns {string | null}
 */
function attr(attrs, name) {
  const match = new RegExp(`${name}=("([^"]*)"|'([^']*)')`).exec(attrs);
  return match ? (match[2] ?? match[3]) : null;
}

function label(kind, title) {
  const head = kind.charAt(0).toUpperCase() + kind.slice(1);
  return title ? `**${head} — ${title}**` : `**${head}**`;
}

/**
 * @param {string} raw a page's full source
 * @param {string} source its path, for error messages
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseFrontmatter(raw, source) {
  const lines = raw.split("\n");
  if (lines[0].trim() !== "---") {
    throw new Error(`${source}: no frontmatter — every docs page needs one`);
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error(`${source}: frontmatter is never closed`);
  }

  const data = {};
  for (const line of lines.slice(1, end)) {
    // Top level only. index.mdx's splash `hero:` block has its own indented
    // `title:`, and reading that one would rename the site's front page.
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    data[match[1]] = unquote(match[2].trim());
  }

  for (const key of ["title", "description"]) {
    if (!data[key]) {
      // Loud, not lenient: a page whose frontmatter this cannot read would
      // otherwise drop out of both generated files without a word.
      throw new Error(`${source}: frontmatter has no \`${key}\``);
    }
  }

  return { data, body: lines.slice(end + 1).join("\n") };
}

function unquote(value) {
  const match = /^"([^"]*)"$|^'([^']*)'$/.exec(value);
  return match ? (match[1] ?? match[2]) : value;
}

/**
 * @param {string} relPath source path below src/content/docs, posix-style
 * @returns {string} the route Starlight serves it at
 */
export function routeForSourcePath(relPath) {
  const withoutExt = relPath.replace(/\.mdx?$/, "");
  const slug = withoutExt === "index" ? "" : withoutExt.replace(/\/index$/, "");
  return slug === "" ? "/" : `/${slug}/`;
}

/**
 * The section a page is listed under. Derived from its directory rather than a
 * label map, so a new directory brings its own section with it — a map is the
 * hand-maintained list this generator exists to stop needing.
 * @param {string} relPath
 * @returns {string}
 */
export function sectionForSourcePath(relPath) {
  const dir = relPath.includes("/") ? relPath.split("/")[0] : "";
  if (dir === "") return "Overview";
  return dir
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * @template {{ route: string, section: string }} T
 * @param {T[]} pages
 * @returns {T[]} Overview first, then sections and routes alphabetically
 */
export function sortPages(pages) {
  const rank = (section) => (section === "Overview" ? 0 : 1);
  return [...pages].sort(
    (a, b) =>
      rank(a.section) - rank(b.section) ||
      a.section.localeCompare(b.section) ||
      // The site's front page leads its section; "/" sorts first anyway, but
      // saying so keeps that independent of the collator's punctuation rules.
      (a.route === "/" ? -1 : b.route === "/" ? 1 : 0) ||
      a.route.localeCompare(b.route),
  );
}

/**
 * Turns a page's MDX body into the markdown an LLM should read: components
 * become plain text, fenced code survives byte-for-byte.
 *
 * @param {string} body
 * @param {{ rawImports?: Map<string, string>, source?: string }} [options]
 * @returns {string}
 */
export function mdxToMarkdown(
  body,
  { rawImports = new Map(), source = "page" } = {},
) {
  /** @type {Array<{ text: string, fenced: boolean }>} */
  const out = [];
  /** @type {{ marker: string, length: number } | null} */
  let fence = null;
  /** Open block components, so their indented children can be dedented. */
  const blocks = [];

  for (const line of body.split("\n")) {
    const fenceMatch = FENCE.exec(line);

    if (fence) {
      out.push({ text: line, fenced: true });
      if (
        fenceMatch &&
        fenceMatch[2][0] === fence.marker &&
        fenceMatch[2].length >= fence.length &&
        fenceMatch[3].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }

    if (fenceMatch) {
      fence = { marker: fenceMatch[2][0], length: fenceMatch[2].length };
      out.push({ text: line, fenced: true });
      continue;
    }

    if (IMPORT_LINE.test(line)) continue;

    const code = CODE_TAG.exec(line);
    if (code) {
      const [, indent, attrs] = code;
      const ident = /code=\{(\w+)\}/.exec(attrs)?.[1];
      const source = ident ? rawImports.get(ident) : undefined;
      if (source === undefined) {
        // Nothing to inline — better an omission than a `<Code …/>` tag
        // published as if it were prose.
        continue;
      }
      const lang = attr(attrs, "lang") ?? "";
      const title = attr(attrs, "title");
      const open = `${indent}\`\`\`${lang}${title ? ` title="${title}"` : ""}`;
      out.push({ text: open, fenced: true });
      for (const codeLine of source.replace(/\n+$/, "").split("\n")) {
        out.push({ text: `${indent}${codeLine}`, fenced: true });
      }
      out.push({ text: `${indent}\`\`\``, fenced: true });
      continue;
    }

    const trimmed = line.trim();
    if (DIRECTIVE_CLOSE.test(trimmed)) continue;
    const directive = DIRECTIVE_OPEN.exec(trimmed);
    if (directive) {
      if (!ASIDE_TYPES.has(directive[1])) {
        throw new Error(
          `${source}: \`:::${directive[1]}\` is not a Starlight aside — it renders as an ` +
            `unstyled <div> with no label. Use one of: ${[...ASIDE_TYPES].join(", ")}.`,
        );
      }
      out.push({ text: label(directive[1], directive[2]), fenced: false });
      continue;
    }

    const indent = /^\s*/.exec(line)[0].length;
    let text = line;
    let replacedBlock = false;

    text = text.replace(
      COMPONENT_TAG,
      (_match, closing, name, attrs, selfClosing) => {
        if (closing) {
          if (blocks.length > 0 && blocks[blocks.length - 1].name === name) {
            blocks.pop();
          }
          return "";
        }
        if (!selfClosing) {
          blocks.push({ name, indent });
          replacedBlock = true;
        }
        if (name === "Badge") {
          const badge = attr(attrs, "text");
          return badge ? `(${badge})` : "";
        }
        if (name === "Aside") {
          return label(attr(attrs, "type") ?? "note", attr(attrs, "title"));
        }
        if (name === "Card") {
          const title = attr(attrs, "title");
          return title ? `### ${title}` : "";
        }
        return "";
      },
    );

    if (text.trim() === "") {
      out.push({ text: "", fenced: false });
      continue;
    }

    // Children of an indented component (index.mdx's `<Card>` bodies sit four
    // spaces in) would read as an indented code block once the tag is gone —
    // and four spaces in front of what a `<Card>` turned into is a heading
    // markdown no longer reads as one.
    const parent = blocks[blocks.length - 1];
    const dedent = replacedBlock
      ? indent
      : parent && parent.indent > 0
        ? parent.indent + 2
        : 0;
    out.push({ text: stripIndent(text, dedent).trimEnd(), fenced: false });
  }

  const collapsed = [];
  for (const entry of out) {
    const blank = !entry.fenced && entry.text.trim() === "";
    const previous = collapsed[collapsed.length - 1];
    if (blank && previous && !previous.fenced && previous.text.trim() === "") {
      continue;
    }
    collapsed.push(entry);
  }

  return collapsed
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function stripIndent(line, amount) {
  if (amount <= 0) return line;
  const leading = /^ */.exec(line)[0].length;
  return line.slice(Math.min(leading, amount));
}

/**
 * @param {string} configText the text of astro.config.mjs
 * @returns {string} the canonical site origin, without a trailing slash
 */
export function readSiteUrl(configText) {
  const match = /^\s*site:\s*["']([^"']+)["']/m.exec(configText);
  if (!match) {
    // Every URL in both files is built from this. A hard-coded fallback would
    // publish an index of links to a host that is not the docs site.
    throw new Error("astro.config.mjs declares no `site:` — cannot build URLs");
  }
  return match[1].replace(/\/$/, "");
}

const GENERATED_BY =
  "Generated from the documentation source at build time — do not edit by hand.";

function versionSuffix(version) {
  return version ? ` This is the documentation for Pinchy ${version}.` : "";
}

/**
 * @param {Array<{ route: string, section: string, title: string, description: string }>} pages
 * @param {{ site: string, title: string, summary: string, version: string | null }} meta
 * @returns {string}
 */
export function buildLlmsTxt(pages, { site, title, summary, version }) {
  if (pages.length === 0)
    throw new Error("refusing to write llms.txt: no pages");

  const lines = [
    `# ${title}`,
    "",
    `> ${summary}`,
    "",
    `${GENERATED_BY}${versionSuffix(version)} The full text of every page below is at ${site}/llms-full.txt.`,
  ];

  let section = null;
  for (const page of sortPages(pages)) {
    if (page.section !== section) {
      section = page.section;
      lines.push("", `## ${section}`, "");
    }
    lines.push(`- [${page.title}](${site}${page.route}): ${page.description}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Array<{ route: string, title: string, body: string, section: string }>} pages
 * @param {{ site: string, title: string, version: string | null }} meta
 * @returns {string}
 */
export function buildLlmsFullTxt(pages, { site, title, version }) {
  if (pages.length === 0) {
    throw new Error("refusing to write llms-full.txt: no pages");
  }

  const header = [
    `# ${title} — Complete Reference`,
    `# Source: ${site}`,
    `# ${GENERATED_BY}${versionSuffix(version)}`,
    "# License: AGPL-3.0 | Publisher: Helmcraft GmbH (https://heypinchy.com)",
  ];

  const sections = sortPages(pages).map((page) =>
    [`# ${page.title}`, `URL: ${site}${page.route}`, "", page.body].join("\n"),
  );

  return `${header.join("\n")}\n\n${sections.join("\n\n---\n\n")}\n`;
}

function walk(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full, base));
    } else if (/\.mdx?$/.test(entry)) {
      files.push(relative(base, full).split(/[\\/]/).join("/"));
    }
  }
  return files;
}

/**
 * @param {string} contentDir
 * @returns {Array<{ route: string, section: string, title: string, description: string, body: string }>}
 */
export function collectPages(contentDir) {
  return walk(contentDir).map((relPath) => {
    const full = join(contentDir, relPath);
    const raw = readFileSync(full, "utf8");
    const { data, body } = parseFrontmatter(raw, relPath);

    const rawImports = new Map();
    for (const line of body.split("\n")) {
      const match = RAW_IMPORT.exec(line);
      if (!match) continue;
      const target = resolve(dirname(full), match[2].replace(/\?raw$/, ""));
      rawImports.set(match[1], readFileSync(target, "utf8"));
    }

    return {
      route: routeForSourcePath(relPath),
      section: sectionForSourcePath(relPath),
      title: data.title,
      description: data.description,
      body: mdxToMarkdown(body, { rawImports, source: relPath }),
    };
  });
}

function readVersion() {
  try {
    return readFileSync(INJECTED_VERSION, "utf8").trim() || null;
  } catch {
    // Only written while a version is injected; a plain `astro build` has none.
    return null;
  }
}

function main() {
  const site = readSiteUrl(readFileSync(ASTRO_CONFIG, "utf8"));
  const pages = collectPages(CONTENT_DIR);

  const front = pages.find((page) => page.route === "/");
  if (!front) {
    throw new Error(
      "src/content/docs has no index page — llms.txt has no title or summary to state",
    );
  }

  const version = readVersion();
  const index = buildLlmsTxt(pages, {
    site,
    title: front.title,
    summary: front.description,
    version,
  });
  const full = buildLlmsFullTxt(pages, { site, title: front.title, version });

  try {
    writeFileSync(join(DIST_DIR, "llms.txt"), index);
    writeFileSync(join(DIST_DIR, "llms-full.txt"), full);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(
        "docs/dist/ not found — this runs after `astro build`, not before it",
      );
    }
    throw err;
  }

  console.log(
    `✅ llms.txt (${pages.length} pages) and llms-full.txt (${Math.round(full.length / 1024)} KB) written to dist/`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`❌ ${err?.message ?? err}`);
    process.exit(1);
  }
}

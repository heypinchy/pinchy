import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_DIR = join(
  fileURLToPath(import.meta.url),
  "../../src/content/docs",
);

/**
 * Scans MDX content for Markdown table syntax (lines beginning with | )
 * that are indented with whitespace. In Starlight/remark-gfm, indented
 * tables — for example inside list items or Steps component steps — do
 * not render as tables; they appear as raw pipe-separated text.
 *
 * Returns an array of { lineNumber, text } for each violation found.
 * Frontmatter and fenced code blocks are skipped.
 */
export function checkContent(content) {
  const lines = content.split("\n");
  const violations = [];
  let inFrontmatter = false;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i === 0 && line === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === "---") inFrontmatter = false;
      continue;
    }

    if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (/^\s+\|/.test(line)) {
      violations.push({ lineNumber: i + 1, text: line });
    }
  }

  return violations;
}

function walkMdx(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkMdx(full));
    } else if (entry.endsWith(".mdx") || entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = walkMdx(DOCS_DIR);
  const failures = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const violations = checkContent(content);
    if (violations.length > 0) {
      const rel = relative(DOCS_DIR, file);
      for (const v of violations) {
        failures.push(`  ${rel}:${v.lineNumber}: ${v.text.trim()}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      "Indented Markdown tables found — these render as raw text in Starlight.",
    );
    console.error(
      "Move the table to the top level or replace it with a nested list.\n",
    );
    for (const f of failures) console.error(f);
    process.exit(1);
  } else {
    console.log("No indented tables found.");
  }
}

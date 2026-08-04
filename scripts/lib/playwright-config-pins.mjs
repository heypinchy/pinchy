/**
 * Drift guard for the Playwright flake-signal pins.
 *
 * AGENTS.md § "No Untracked Sleeps In E2E" states the property in passing:
 * every Playwright config here pins `retries: 0, workers: 1` on purpose — a
 * flake is a signal, not something a rerun hides. Nothing pinned that claim
 * itself. A well-meaning `retries: 2` landing in one of the nine
 * `playwright*.config.ts` files under `packages/web` would quietly turn a
 * real flake into an intermittent pass, and CI would stay green while doing
 * so.
 *
 * The property is not just "retries: 0, workers: 1 literally appear" — a
 * config could set `workers: 1` and still race two specs against one stack
 * via `fullyParallel: true` (`workers` bounds concurrent worker *processes*,
 * while `fullyParallel: true` additionally lets tests *within* one file run
 * against each other). Every config here that states the field spells it out
 * as `false`; this guard forbids `true` for the same reason it forbids
 * `retries` above 0: specs in this repo call `resetStack()` (truncates the
 * DB, restarts containers) or share one OpenClaw session, so two specs
 * running concurrently inside one stack wipe each other's state.
 *
 * `retries` and `fullyParallel` are checked at **every** nesting depth, not
 * only the top level, because Playwright honours a per-project override:
 * `projects: [{ name: "chromium", retries: 3 }]` defeats a top-level
 * `retries: 0` for that project while leaving the top-level pin visibly
 * intact. `workers` has no project-level form, so it is required (and
 * checked) at the top level only.
 *
 * Text analysis, not `require()`/dynamic import: these are Playwright
 * `defineConfig()` modules meant to run under Playwright's own loader, and
 * importing them here would need every mock server and DB env var they
 * reference (see the `webServer.command` block in playwright.config.ts).
 * Reading the source text is what the analogous *-gate guards in this
 * directory already do (see node-version-pin.mjs's Dockerfile/workflow
 * readers).
 *
 * But a *regex* over that text is not good enough, and the reason is the
 * one AGENTS.md keeps naming: a check that reports on the presence of a
 * string reports on the presence of a string. A first-match regex reads
 *
 *     // retries: 0 — a flake is a signal, see AGENTS.md
 *     retries: 2,
 *
 * as a compliant config, because the comment matches first — and that
 * comment is exactly what a developer writes next to the pin, or leaves
 * behind after deleting it. `node-version-pin.mjs` makes the same point
 * about Dockerfiles ("the guard reads FROM lines only, never prose"). So
 * this one tokenizes: `extractConfigEntries` skips comments and string
 * literals and tracks brace depth, so only real object entries are read.
 * The `//` in `baseURL: "http://localhost:7778"` is why the string-skipping
 * half is not optional either.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

// Matches every `playwright*.config.ts` file: the bare `playwright.config.ts`
// and every suffixed variant (`playwright.odoo.config.ts`,
// `playwright.email.config.ts`, `playwright.eval.config.ts`, ...).
const CONFIG_FILE_PATTERN = /^playwright.*\.config\.ts$/;

// Directories a source-tree walk must not descend into: installed packages
// ship their own Playwright configs, and build output is generated.
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);

const QUOTES = new Set(['"', "'", "`"]);
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

/**
 * Discover every Playwright config file under a web package root.
 *
 * The walk is **recursive**, and that is not incidental tidiness. A
 * top-level-only readdir misses `packages/web/eval/playwright.eval.config.ts`
 * — a ninth config, run by `pnpm eval:selftest` in CI, that a package-root
 * glob leaves entirely unguarded. Same lesson as AGENTS.md § "A
 * Hand-Maintained List That Mirrors Code Will Be Wrong": a guard whose scope
 * is narrower than the thing it claims to cover reports on what it looks at,
 * not on what it should.
 * @param {string} webRoot absolute path to packages/web
 * @returns {string[]} sorted absolute file paths
 */
export function discoverPlaywrightConfigs(webRoot) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name))
          continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && CONFIG_FILE_PATTERN.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(webRoot);
  return found.sort();
}

/**
 * Every Playwright config a `packages/web/package.json` script actually runs.
 *
 * The corpus floor below is a backstop against a discovery glob that finds
 * nothing; this is the sharper question — a config the scripts run but the
 * glob misses (a differently named file, or one moved into a subdirectory)
 * would be unguarded while the floor stayed satisfied by its siblings. A
 * bare `playwright test` resolves `playwright.config.ts` in the package
 * root, so it contributes that name implicitly.
 * @param {string} packageJsonText raw packages/web/package.json contents
 * @returns {string[]} sorted, de-duplicated config file names
 */
export function configsReferencedByScripts(packageJsonText) {
  const scripts = JSON.parse(packageJsonText).scripts ?? {};
  const referenced = new Set();
  for (const command of Object.values(scripts)) {
    if (typeof command !== "string" || !/\bplaywright test\b/.test(command)) {
      continue;
    }
    const explicit = [...command.matchAll(/--config[=\s]+(\S+)/g)];
    if (explicit.length === 0) {
      referenced.add("playwright.config.ts");
      continue;
    }
    for (const [, path] of explicit) {
      referenced.add(path.replace(/^\.\//, ""));
    }
  }
  return [...referenced].sort();
}

/**
 * Skip a string literal starting at `i`. Returns the index just past it.
 * @param {string} src
 * @param {number} i index of the opening quote
 * @returns {number}
 */
function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === quote) return j + 1;
    j += 1;
  }
  return j;
}

/**
 * Skip a `//` or block comment starting at `i`.
 * @param {string} src
 * @param {number} i
 * @returns {number} index just past the comment, or -1 if `i` starts none
 */
function skipComment(src, i) {
  if (src[i] !== "/") return -1;
  if (src[i + 1] === "/") {
    let j = i + 2;
    while (j < src.length && src[j] !== "\n") j += 1;
    return j;
  }
  if (src[i + 1] === "*") {
    let j = i + 2;
    while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
    return Math.min(j + 2, src.length);
  }
  return -1;
}

/**
 * Read the raw text of a value starting just after its `:`, stopping at the
 * `,` or closing bracket that ends it. Nested brackets, strings and comments
 * are consumed rather than treated as terminators, so `use: { a: "x, y" }`
 * reads as one value and `retries: 0, // pin` reads as `0`.
 * @param {string} src
 * @param {number} start index just past the colon
 * @returns {string} the value text, comments removed, trimmed
 */
function readRawValue(src, start) {
  const chunks = [];
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const pastComment = skipComment(src, i);
    if (pastComment !== -1) {
      i = pastComment;
      continue;
    }
    const ch = src[i];
    if (QUOTES.has(ch)) {
      const end = skipString(src, i);
      chunks.push(src.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      break;
    }
    chunks.push(ch);
    i += 1;
  }
  return chunks.join("").trim();
}

/**
 * Tokenize a config's source into its `key: value` entries.
 *
 * Comments and string literals are skipped, so neither a commented-out pin
 * nor a `//` inside a URL is mistaken for configuration. `depth` counts
 * `{`/`[` nesting: the entries of the object passed to `defineConfig({...})`
 * sit at depth 1, a `projects: [{ ... }]` member's entries at depth 3.
 * @param {string} text raw config file contents
 * @returns {{ key: string, value: string, depth: number }[]}
 */
export function extractConfigEntries(text) {
  const src = String(text ?? "");
  const entries = [];
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const pastComment = skipComment(src, i);
    if (pastComment !== -1) {
      i = pastComment;
      continue;
    }
    const ch = src[i];
    if (QUOTES.has(ch)) {
      i = skipString(src, i);
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let end = i;
      while (end < src.length && IDENT_PART.test(src[end])) end += 1;
      let afterKey = end;
      while (afterKey < src.length && /\s/.test(src[afterKey])) afterKey += 1;
      if (src[afterKey] === ":" && src[afterKey + 1] !== ":") {
        entries.push({
          key: src.slice(i, end),
          value: readRawValue(src, afterKey + 1),
          depth,
        });
        // Resume just past the colon rather than past the value, so entries
        // nested inside it (a project-level `retries`) are seen too.
        i = afterKey + 1;
        continue;
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return entries;
}

/**
 * Validate one Playwright config's *source text* against the flake-signal
 * pins: `retries: 0`, `workers: 1`, and no `fullyParallel: true`.
 * @param {string} text raw config file contents
 * @returns {string[]} one message per problem; empty means correctly pinned
 */
export function validatePlaywrightConfigText(text) {
  const problems = [];
  const entries = extractConfigEntries(text);
  const where = (entry) =>
    entry.depth === 1 ? "" : ` (nested at depth ${entry.depth})`;

  const retries = entries.filter((entry) => entry.key === "retries");
  if (!retries.some((entry) => entry.depth === 1)) {
    problems.push(
      "missing retries: 0 — the pin is what makes a later `retries: 2` a deliberate, reviewable edit rather than a default nobody stated.",
    );
  }
  for (const entry of retries.filter((e) => e.value !== "0")) {
    problems.push(
      `retries is ${JSON.stringify(entry.value)}${where(entry)}, expected 0 — a retry can pass by re-running against DB state (or an OpenClaw session) the first attempt already mutated, silently hiding the flake instead of reporting it.`,
    );
  }

  const workers = entries.filter(
    (entry) => entry.key === "workers" && entry.depth === 1,
  );
  if (workers.length === 0) {
    problems.push(
      "missing workers: 1 — without it Playwright sizes the worker pool off CPU count, and specs here truncate the DB / restart containers, so two workers can wipe each other's state.",
    );
  }
  for (const entry of workers.filter((e) => e.value !== "1")) {
    problems.push(
      `workers is ${JSON.stringify(entry.value)}, expected 1 — specs here truncate the DB / restart containers or share one OpenClaw session, so more than one worker can wipe another spec's state.`,
    );
  }

  for (const entry of entries.filter(
    (e) => e.key === "fullyParallel" && e.value === "true",
  )) {
    problems.push(
      `fullyParallel is true${where(entry)}, expected false (or absent) — it races tests within one file against a stack that resetStack()/shared-session specs assume is exclusively theirs.`,
    );
  }

  return problems;
}

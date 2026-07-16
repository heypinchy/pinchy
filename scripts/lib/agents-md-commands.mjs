/**
 * Drift guard for the commands documented in AGENTS.md.
 *
 * AGENTS.md is the first file every coding agent reads, so a command that no
 * longer exists costs time in every future session — and nothing else in CI
 * reads it. That is how `pnpm lint`, `pnpm format` and `pnpm db:generate` came
 * to sit in the "Commands" section for months without any of them resolving to
 * a script.
 *
 * This walks every ```bash block in AGENTS.md, works out which package each
 * `pnpm <script>` invocation would run in, and fails if the script isn't
 * declared there. Read-side sibling of the no-untracked-skips /
 * no-test-deletion / plugin-typecheck / web-typecheck guards.
 *
 * Scope: it proves the package a command targets declares the script — e.g.
 * that `pnpm -C packages/web lint` names a real web script. It does NOT follow
 * a root proxy through to the script behind it: were the root to proxy `lint`
 * on to `@pinchy/web`, renaming the web script would break the proxy without
 * tripping this guard. CI runs the web scripts directly, so that drift surfaces
 * there instead.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// pnpm's own subcommands: `pnpm install` is not a claim that an "install"
// script exists. `run` is absent deliberately — it is handled before this set
// is consulted, because its argument IS a script name.
const BUILTINS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "update",
  "up",
  "exec",
  "dlx",
  "why",
  "outdated",
  "audit",
  "publish",
  "pack",
  "link",
  "list",
  "ls",
  "store",
  "licenses",
  "import",
  "prune",
  "rebuild",
  "setup",
  "config",
]);

// Flags that swallow the following token, mapped to what they select.
const TARGET_FLAGS = { "-C": "dir", "--dir": "dir", "--filter": "filter" };

const FENCED_BASH = /^```bash\n([\s\S]*?)^```/gm;
const ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]*=\S*$/;

/**
 * Parse the tokens after `pnpm` into the script it would run, if any.
 *
 * @param {string[]} tokens
 * @param {string} cwd directory the command runs in, relative to the repo root
 * @returns {{ target: { type: "dir" | "filter", value: string }, script: string } | null}
 */
function parsePnpmTokens(tokens, cwd) {
  let target = { type: "dir", value: cwd };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const swallows = TARGET_FLAGS[token];
    if (swallows) {
      target = { type: swallows, value: tokens[i + 1] };
      i += 2;
      continue;
    }
    const inline = token.match(/^(--filter|--dir)=(.+)$/);
    if (inline) {
      target = { type: inline[1] === "--filter" ? "filter" : "dir", value: inline[2] };
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }

  const first = tokens[i];
  if (first === undefined) return null;
  if (first === "run") {
    const script = tokens[i + 1];
    return script === undefined ? null : { target, script };
  }
  if (BUILTINS.has(first)) return null;
  return { target, script: first };
}

/**
 * Every `pnpm <script>` invocation documented in the markdown's bash blocks.
 *
 * @param {string} markdown
 * @returns {Array<{ line: string, target: { type: "dir" | "filter", value: string }, script: string }>}
 */
export function extractPnpmInvocations(markdown) {
  const invocations = [];
  for (const [, block] of markdown.matchAll(FENCED_BASH)) {
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;

      // A `cd` earlier in the chain decides where a later `pnpm` runs.
      let cwd = ".";
      for (const segment of line.split("&&")) {
        const tokens = segment.trim().split(/\s+/).filter(Boolean);
        while (tokens.length > 0 && ENV_ASSIGNMENT.test(tokens[0])) tokens.shift();
        const [command, ...rest] = tokens;
        if (command === "cd") {
          cwd = rest[0] ?? ".";
        } else if (command === "pnpm") {
          const parsed = parsePnpmTokens(rest, cwd);
          if (parsed) invocations.push({ line, ...parsed });
        }
      }
    }
  }
  return invocations;
}

/** "./docs/" and "docs" name the same package; "" and "./" name the root. */
function normalizeDir(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed === "" || trimmed === "." ? "." : trimmed;
}

/** pnpm filters allow `*`, e.g. `--filter "./packages/plugins/*"`. */
function matchesGlob(pattern, value) {
  if (typeof value !== "string") return false;
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? "[^/]*" : `\\${c}`));
  return new RegExp(`^${source}$`).test(value);
}

function readPackage(repoRoot, dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
    return {
      dir,
      name: typeof pkg.name === "string" ? pkg.name : null,
      scripts: Object.keys(pkg.scripts ?? {}),
    };
  } catch {
    // No package.json here (e.g. packages/plugins itself), or it is unreadable.
    return null;
  }
}

/** Every directory that could hold a package: the root, the workspace globs, and docs/. */
function packageDirs(repoRoot) {
  const dirs = ["."];
  let yaml = "";
  try {
    yaml = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  } catch {
    yaml = "";
  }
  for (const line of yaml.split("\n")) {
    const glob = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/)?.[1];
    if (!glob?.endsWith("/*")) continue;
    const parent = glob.slice(0, -2);
    try {
      for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
      }
    } catch {
      // Glob points at a directory that does not exist; nothing to contribute.
    }
  }
  // docs/ is standalone (own lockfile, not a workspace member) but AGENTS.md
  // documents `cd docs && pnpm build`, so the guard has to resolve it too.
  dirs.push("docs");
  return dirs;
}

/**
 * Resolve a documented pnpm target against the packages that actually exist.
 *
 * Derived from the filesystem rather than a hand-written list: an enumeration
 * would itself be a drift source, and would fail a correctly documented
 * command for any package it had not been taught about.
 *
 * @param {string} repoRoot
 * @returns {(target: { type: "dir" | "filter", value: string }) => string[] | null}
 */
export function createWorkspaceResolver(repoRoot) {
  const packages = packageDirs(repoRoot)
    .map((dir) => readPackage(repoRoot, dir))
    .filter((pkg) => pkg !== null);

  return (target) => {
    const matches = packages.filter((pkg) =>
      target.type === "dir"
        ? normalizeDir(target.value) === pkg.dir
        : matchesGlob(target.value, pkg.name) ||
          matchesGlob(normalizeDir(target.value) ?? "\0", pkg.dir),
    );
    // A glob filter runs the script in every match, so any of them declaring it
    // means the documented command does something.
    return matches.length === 0 ? null : [...new Set(matches.flatMap((pkg) => pkg.scripts))];
  };
}

/**
 * @param {string} markdown contents of AGENTS.md
 * @param {(target: { type: "dir" | "filter", value: string }) => string[] | null} resolveScripts
 *   the script names declared by the targeted package, or null if no such package
 * @returns {string[]} problems (empty = ok)
 */
export function checkAgentsMdCommands(markdown, resolveScripts) {
  const problems = [];
  for (const { line, target, script } of extractPnpmInvocations(markdown)) {
    const scripts = resolveScripts(target);
    if (scripts === null) {
      problems.push(
        `\`${line}\` targets ${target.type} "${target.value}", which is not a package in this workspace`,
      );
      continue;
    }
    if (!scripts.includes(script)) {
      const where = target.type === "dir" ? `"${target.value}"` : `package "${target.value}"`;
      const rootHint = target.type === "dir" && target.value === "." ? " (root package.json)" : "";
      problems.push(
        `\`${line}\` runs script "${script}" in ${where}${rootHint}, which declares no such script`,
      );
    }
  }
  return problems;
}

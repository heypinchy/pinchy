/**
 * Guard for the pre-commit hook's own tooling.
 *
 * The hook does three things: it blocks local absolute paths, it checks drizzle
 * snapshot integrity, and it runs lint-staged. Only the third one can fail for a
 * reason that has nothing to do with the commit — a node_modules older than
 * package.json — and when it does, the committer reaches for `--no-verify`,
 * which skips all three. A formatting tool that is merely not installed thereby
 * disables two integrity checks. That is the failure this module exists to stop
 * (#838), and it can arrive from two directions:
 *
 *   1. STALE INSTALL. prettier became a root devDependency only in 9fd765023
 *      ("make the format gate cover the whole repo"); a node_modules from before
 *      that commit never linked node_modules/.bin/prettier, so lint-staged dies
 *      with a bare ENOENT that names no fix. `check-precommit-tooling.mjs` runs
 *      this check up front and prints the instruction instead.
 *
 *   2. A PACKAGE-MANAGER WRAPPER around the whole-tree command. lint-staged puts
 *      every ancestor node_modules/.bin on PATH, so a directly-invoked binary
 *      resolves from a git worktree too: the worktrees live under the main
 *      checkout, and the walk reaches its node_modules. `pnpm exec` ignores that
 *      PATH and resolves through the workspace it finds instead — and a worktree
 *      root IS a workspace root (pnpm-workspace.yaml) with no node_modules, so
 *      the exec goes recursive over the workspace packages and dies with
 *      ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL ("Command not found"). The failure
 *      keys on the workspace root, not on the missing node_modules as such:
 *      measured, `pnpm -C <dir> exec` from a NON-workspace directory does reach
 *      the ancestor install. That is why the wrapper looks harmless when tried
 *      anywhere but where the hook actually runs. Wrapping the whole-tree rule
 *      trades a stale-install failure for an every-worktree-commit failure.
 *
 * The third property is SCOPE, and it is the same one `format-gate.mjs` guards
 * for CI: the whole-tree rule is what makes the hook format anything outside
 * packages/web/src. Narrow it and every commit to scripts/, config/, docs/ or
 * the plugins is formatted by nothing, with the hook still green.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Rule keys that lint-staged matches against every staged path. */
const CATCH_ALL_PATTERNS = new Set(["*", "**", "**/*"]);

/** Binaries a package manager would have to resolve for us, and cannot. */
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "npx", "yarn", "bun", "bunx"]);

/**
 * @param {unknown} config the root package.json `lint-staged` block
 * @returns {string[]} every command of every whole-tree rule
 */
export function catchAllCommands(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }
  return Object.entries(config)
    .filter(([pattern]) => CATCH_ALL_PATTERNS.has(pattern))
    .flatMap(([, commands]) =>
      (Array.isArray(commands) ? commands : [commands]).filter(
        (command) => typeof command === "string" && command.trim() !== "",
      ),
    );
}

/**
 * @param {string} command a single whole-tree lint-staged command
 * @returns {string[]} problems (empty = ok)
 */
export function validateCatchAllCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return ["a whole-tree lint-staged command must be a non-empty string"];
  }
  const binary = command.trim().split(/\s+/)[0];
  if (!PACKAGE_MANAGERS.has(binary)) return [];
  return [
    `the whole-tree lint-staged command must invoke its binary directly (got \`${binary}\` in ` +
      `\`${command}\`); lint-staged puts every ancestor node_modules/.bin on PATH, so a bare binary ` +
      `resolves from a git worktree by walking up into the main checkout's install, while ` +
      `\`${binary}\` ignores that PATH and resolves through the workspace it finds — at an ` +
      `uninstalled worktree root that is a recursive exec over the workspace packages, and it fails`,
  ];
}

/**
 * The directories lint-staged prepends to PATH: node_modules/.bin of the start
 * directory and of every ancestor, nearest first.
 *
 * @param {string} startDir
 * @returns {string[]}
 */
export function binDirsFor(startDir) {
  const dirs = [];
  let current = startDir;
  for (;;) {
    dirs.push(join(current, "node_modules", ".bin"));
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

/**
 * @param {string} binary
 * @param {string[]} binDirs
 * @param {(path: string) => boolean} [exists] injectable for tests; defaults to fs
 * @returns {string | null} the resolved path, or null
 */
export function resolveBinary(binary, binDirs, exists = existsSync) {
  for (const dir of binDirs) {
    // .cmd is what pnpm links on Windows; the hook runs there too.
    for (const candidate of [join(dir, binary), join(dir, `${binary}.cmd`)]) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Every binary the hook needs on EVERY commit: lint-staged itself, plus the
 * whole-tree rule's binaries (a whole-tree rule matches any staged file by
 * definition). Rules scoped to a subtree are deliberately not included — they
 * may legitimately not run for a given commit.
 *
 * @param {unknown} config the root package.json `lint-staged` block
 * @returns {string[]}
 */
export function requiredBinaries(config) {
  const binaries = catchAllCommands(config)
    .map((command) => command.trim().split(/\s+/)[0])
    .filter((binary) => !PACKAGE_MANAGERS.has(binary));
  return [...new Set(["lint-staged", ...binaries])];
}

/**
 * What a single lint-staged command actually executes, and where.
 *
 * A rule scoped to one package legitimately wraps its binary — the binary lives
 * in that package, not at the root — so for those the useful question is not
 * "is this wrapped" but "would pnpm find anything in that directory". Wrappers
 * that resolve through another package.json (`pnpm run`, `--filter`) are not
 * decidable here, and guessing is worse than silence: this feeds the explain
 * path, which must never report a missing binary when the real failure was a
 * lint error.
 *
 * @param {string} command
 * @returns {{ binary: string, dir: string } | null} null = not decidable
 */
export function parseInvocation(command) {
  if (typeof command !== "string" || command.trim() === "") return null;
  const tokens = command.trim().split(/\s+/);
  if (!PACKAGE_MANAGERS.has(tokens[0])) {
    return { binary: tokens[0], dir: "." };
  }

  let dir = ".";
  let index = 1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-C" || token === "--dir") {
      dir = tokens[index + 1] ?? ".";
      index += 1;
      continue;
    }
    if (token === "exec") continue;
    break;
  }
  const binary = tokens[index];
  // `pnpm run format`, `pnpm --filter … exec eslint`: the leftovers of a wrapper
  // whose target we did not fully consume, or one that selects by package name.
  if (!binary || binary.startsWith("-") || binary === "run") return null;
  return { binary, dir };
}

/**
 * Every binary any lint-staged rule can invoke, with the directory it is
 * resolved from. Used only to explain a failure that already happened — see
 * `requiredBinaries` for the up-front check, which is deliberately limited to
 * what runs on every commit.
 *
 * @param {unknown} config the root package.json `lint-staged` block
 * @returns {{ binary: string, dir: string }[]}
 */
export function allToolingRequirements(config) {
  const requirements = [{ binary: "lint-staged", dir: "." }];
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return requirements;
  }
  for (const commands of Object.values(config)) {
    for (const command of Array.isArray(commands) ? commands : [commands]) {
      const invocation = parseInvocation(command);
      if (invocation === null) continue;
      if (
        requirements.some(
          (r) => r.binary === invocation.binary && r.dir === invocation.dir,
        )
      ) {
        continue;
      }
      requirements.push(invocation);
    }
  }
  return requirements;
}

/**
 * @param {string[]} missing binaries that did not resolve
 * @returns {string}
 */
export function formatMissingToolingMessage(missing) {
  return [
    `❌ Pre-commit tooling is not installed: ${missing.join(", ")}`,
    "",
    "   This checkout cannot resolve it — an install older than package.json, or",
    "   a fresh git worktree that was never installed. From this checkout, run:",
    "",
    "     pnpm install",
    "",
    "   Do NOT commit with --no-verify: it skips this hook entirely, including",
    "   the drizzle-snapshot check and the absolute-path guard above.",
  ].join("\n");
}

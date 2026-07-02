/**
 * Pure logic for the plugin typecheck gate (see scripts/typecheck-plugins.mjs
 * for the CLI/CI wrapper and AGENTS.md § "Plugin Integration Contract").
 *
 * Plugins in packages/plugins/pinchy-* run via tsx at runtime with no
 * ahead-of-time type checking anywhere — no `tsc` in CI, no build step in
 * Dockerfile.openclaw. This module discovers the plugin packages and validates
 * that each one's tsconfig.json is wired so `tsc --noEmit` actually checks its
 * production *and* test files. It is the read-side sibling of the
 * no-untracked-skips / no-test-deletion guards: a new plugin must not be able
 * to silently escape the gate.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Directory prefix that marks a first-party Pinchy plugin package.
export const PLUGIN_DIR_PREFIX = "pinchy-";

/**
 * Discover first-party plugin package directories under a plugins root.
 * @param {string} pluginsRoot absolute path to packages/plugins
 * @returns {string[]} sorted absolute plugin directory paths
 */
export function discoverPluginDirs(pluginsRoot) {
  return readdirSync(pluginsRoot)
    .filter((name) => name.startsWith(PLUGIN_DIR_PREFIX))
    .map((name) => join(pluginsRoot, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

// An exclude entry drops test files if it targets *.test.ts / *.spec.ts or a
// __tests__ directory. Root-only `*.ts` includes are handled separately.
const TEST_EXCLUDE_RE = /(test|spec)\.|__tests__/;

/**
 * Validate a parsed tsconfig object against the rules the typecheck gate needs.
 * Pure — takes the already-parsed JSON, returns a list of human-readable
 * problems (empty means the config is correctly wired).
 * @param {Record<string, unknown>} cfg
 * @returns {string[]}
 */
export function validateTsconfigShape(cfg) {
  const problems = [];

  const include = Array.isArray(cfg?.include) ? cfg.include : [];
  // `**/*.ts` (not `*.ts`) is what pulls in __tests__/*.test.ts and any other
  // nested source, so the expectTypeOf contract tests become real compile-time
  // checks instead of runtime no-ops.
  if (!include.includes("**/*.ts")) {
    problems.push(
      `include must contain "**/*.ts" so production and test files are typechecked (got ${JSON.stringify(
        cfg?.include ?? null,
      )})`,
    );
  }

  const exclude = Array.isArray(cfg?.exclude) ? cfg.exclude : [];
  const testExcludes = exclude.filter(
    (entry) => typeof entry === "string" && TEST_EXCLUDE_RE.test(entry),
  );
  if (testExcludes.length > 0) {
    problems.push(
      `exclude must not drop test files (found ${JSON.stringify(testExcludes)})`,
    );
  }

  const compilerOptions =
    cfg && typeof cfg.compilerOptions === "object" ? cfg.compilerOptions : {};
  const types = Array.isArray(compilerOptions.types) ? compilerOptions.types : [];
  // Plugins import node builtins (fs, path, node:dns, ...). Without an explicit
  // "node" type (backed by an @types/node devDep) tsc cannot resolve them.
  if (!types.includes("node")) {
    problems.push(
      'compilerOptions.types must include "node" (backed by an @types/node devDependency)',
    );
  }

  // Third-party type packages (e.g. linkedom) ship .d.ts files that don't
  // typecheck cleanly under strict mode; without skipLibCheck they break the
  // gate for reasons unrelated to our code.
  if (compilerOptions.skipLibCheck !== true) {
    problems.push("compilerOptions.skipLibCheck must be true");
  }

  return problems;
}

/**
 * Validate a parsed package.json against the rules the typecheck gate needs.
 * Pure — `types: ["node"]` in tsconfig throws TS2688 unless @types/node is an
 * actual (dev)dependency, so the fast guard checks for it too.
 * @param {Record<string, unknown>} pkg
 * @returns {string[]}
 */
export function validatePackageShape(pkg) {
  const problems = [];
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  if (!("@types/node" in deps)) {
    problems.push(
      "package.json must declare an @types/node devDependency (tsconfig sets types: [\"node\"])",
    );
  }
  return problems;
}

/**
 * Validate a plugin directory: its tsconfig.json and package.json must exist,
 * parse, and pass {@link validateTsconfigShape} / {@link validatePackageShape}.
 * @param {string} pluginDir absolute plugin directory path
 * @returns {string[]} problems (empty means correctly wired)
 */
export function validatePluginDir(pluginDir) {
  const tsconfigPath = join(pluginDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    return ["missing tsconfig.json"];
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  } catch (err) {
    return [`tsconfig.json is not valid JSON: ${err.message}`];
  }
  const problems = validateTsconfigShape(cfg);

  const packagePath = join(pluginDir, "package.json");
  if (!existsSync(packagePath)) {
    problems.push("missing package.json");
    return problems;
  }
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    problems.push(...validatePackageShape(pkg));
  } catch (err) {
    problems.push(`package.json is not valid JSON: ${err.message}`);
  }
  return problems;
}

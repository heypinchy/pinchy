/**
 * Pure logic for the plugin smoke-load gate (see scripts/smoke-load-plugins.mjs
 * for the CLI/CI wrapper and AGENTS.md § "Plugin Integration Contract").
 *
 * The incident this gate exists to catch: `googleapis` was missing from
 * pinchy-email's production install, gmail-adapter.ts threw at import time,
 * and all 6 email tools silently disappeared from the tool list — no error,
 * no signal, just fewer tools. `scripts/typecheck-plugins.mjs` cannot catch
 * this class of bug (a missing *runtime* dependency typechecks fine against
 * the type declarations still present in devDependencies). This is the
 * runtime complement: load each plugin with ONLY its production dependencies
 * installed (mirroring Dockerfile.openclaw's per-plugin `npm install
 * --omit=dev`) and confirm it registers exactly the tools it declares.
 *
 * A plugin's index.ts is not the whole story: it may load a sibling module
 * (e.g. an adapter) lazily via dynamic `import()` specifically so that a
 * broken *optional* dependency doesn't crash the whole plugin at load time.
 * A smoke test that only imports index.ts would never exercise that sibling
 * and would miss exactly the bug class above. `discoverReachableModules`
 * below walks the plugin's own import graph — both static `import`/`export
 * ... from` and dynamic `import()` — starting at index.ts, so every module
 * genuinely reachable from the plugin's entry point gets imported and its
 * top-level production-dependency imports get exercised.
 *
 * Deliberately NOT "import every .ts file in the plugin directory": some
 * plugins ship standalone dev-tooling scripts alongside their runtime code
 * (e.g. pinchy-files/generate-test-fixtures.ts, run manually via `npx tsx`
 * to regenerate test fixtures) that import devDependencies and are never
 * loaded by OpenClaw at runtime. Reachability from index.ts naturally
 * excludes those — they're dead ends nothing imports — without needing an
 * ad hoc filename denylist that would have to be maintained by hand.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/**
 * Whether a plugin directory has the `index.ts` entry point OpenClaw loads.
 * A plugin without one can't be smoke-loaded at all — skip it gracefully
 * rather than failing on a missing file the contract doesn't require.
 * @param {string} pluginDir
 * @returns {boolean}
 */
export function hasIndexEntry(pluginDir) {
  return existsSync(join(pluginDir, "index.ts"));
}

/**
 * Read `contracts.tools` from a plugin's openclaw.plugin.json.
 *
 * Returns `null` (meaning "skip this plugin, nothing to compare") when the
 * manifest is missing, unparsable, or has no `contracts.tools` array at all
 * — sidecar plugins (pinchy-audit, pinchy-transcript) register no
 * agent-facing tools and have no `contracts` key, which is a legitimate
 * shape, not an error.
 *
 * Returns `[]` (a real, comparable empty set) when `contracts.tools` is
 * present and empty — that's still worth checking: it asserts the plugin
 * registers zero tools, which is exactly what a sidecar plugin's register()
 * should do.
 * @param {string} pluginDir
 * @returns {string[] | null}
 */
export function readDeclaredTools(pluginDir) {
  const manifestPath = join(pluginDir, "openclaw.plugin.json");
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const tools = manifest?.contracts?.tools;
  return Array.isArray(tools) ? tools : null;
}

/**
 * Whether a parsed package.json declares at least one production dependency.
 * Plugins with none (pinchy-audit, pinchy-context, pinchy-docs,
 * pinchy-transcript) need no isolated `npm install --omit=dev` step —
 * Dockerfile.openclaw doesn't run one for them either — but their modules
 * still get smoke-imported.
 * @param {{ dependencies?: Record<string, string> }} pkg
 * @returns {boolean}
 */
export function hasProdDependencies(pkg) {
  return Object.keys(pkg?.dependencies ?? {}).length > 0;
}

/**
 * Compare the set of tool names a plugin actually registered (captured by the
 * smoke-load harness's `registerTool` stub) against the set it declares in
 * `contracts.tools`. Set semantics: order and duplicate registrations don't
 * matter, only membership does.
 * @param {string[]} registered
 * @param {string[]} declared
 * @returns {{ ok: boolean, missing: string[], extra: string[] }}
 */
export function compareToolSets(registered, declared) {
  const registeredSet = new Set(registered);
  const declaredSet = new Set(declared);
  const missing = [...declaredSet].filter((t) => !registeredSet.has(t)).sort();
  const extra = [...registeredSet].filter((t) => !declaredSet.has(t)).sort();
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

// Matches:
//   import ... from "spec"
//   export ... from "spec"
//   import "spec"                (bare side-effect import)
//   import("spec")                (dynamic import, any amount of whitespace)
const STATIC_IMPORT_RE = /\b(?:import|export)\b[^;'"]*?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Extract every module specifier a source file imports — both static
 * `import`/`export ... from` statements and dynamic `import()` calls —
 * de-duplicated in first-seen order. This is a lightweight regex scan, not a
 * real parser: good enough for the plugins' plain import statements, and
 * deliberately simple to keep this gate's own logic auditable.
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
  const seen = new Set();
  const ordered = [];
  const add = (spec) => {
    if (!seen.has(spec)) {
      seen.add(spec);
      ordered.push(spec);
    }
  };

  for (const match of source.matchAll(STATIC_IMPORT_RE)) add(match[1]);
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) add(match[1]);

  return ordered;
}

/**
 * Resolve a relative import specifier (e.g. "./adapter.js") to the sibling
 * `.ts` source file it refers to. Plugins write NodeNext-style ".js"
 * extensions in import specifiers while the file on disk is ".ts" — strip
 * whatever extension is present (or none) and always resolve to ".ts".
 * Bare/scoped package specifiers (no "./" or "../" prefix) return `null` —
 * those are external dependencies, not plugin-internal modules to smoke-load.
 * @param {string} fromDir directory the importing file lives in
 * @param {string} specifier raw import specifier
 * @returns {string | null} absolute path to the sibling .ts file, or null
 */
export function resolveSiblingModulePath(fromDir, specifier) {
  if (!specifier.startsWith(".")) return null;
  const withoutExt = specifier.replace(/\.(m?[jt]sx?|cjs)$/, "");
  return resolve(fromDir, `${withoutExt}.ts`);
}

/**
 * Walk a plugin's own import graph starting at `entryFileName` (default
 * "index.ts"), following both static and dynamic relative imports
 * transitively, and return every reachable sibling `.ts` file (including the
 * entry itself). Bare package specifiers are left alone — that's the
 * production-dependency surface `npm install --omit=dev` is responsible for.
 *
 * This is deliberately reachability-based rather than "every .ts file in the
 * directory": see the module-level comment for why (dev-tooling scripts that
 * import devDependencies and are never loaded by OpenClaw must not be
 * dragged into the smoke-load).
 * @param {string} pluginDir
 * @param {string} [entryFileName]
 * @returns {string[]} sorted absolute paths, or [] if the entry doesn't exist
 */
export function discoverReachableModules(pluginDir, entryFileName = "index.ts") {
  const entryPath = join(pluginDir, entryFileName);
  if (!existsSync(entryPath)) return [];

  const visited = new Set();
  const queue = [entryPath];

  while (queue.length > 0) {
    const filePath = queue.shift();
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    for (const specifier of extractImportSpecifiers(source)) {
      const resolved = resolveSiblingModulePath(dirname(filePath), specifier);
      if (resolved && existsSync(resolved) && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return [...visited].sort();
}

#!/usr/bin/env node
/**
 * Smoke-load gate for the packages/plugins/pinchy-* plugin packages.
 *
 * The incident this exists to catch: `googleapis` was missing from
 * pinchy-email's production dependency bundle. gmail-adapter.ts (which
 * imports googleapis at its top level) threw when loaded, and OpenClaw
 * silently dropped all 6 email tools — no error surfaced anywhere. Neither
 * `scripts/typecheck-plugins.mjs` (tsc sees devDependencies' type
 * declarations, so a missing *runtime* dependency typechecks fine) nor the
 * static `manifest-tools-drift.test.ts` guard (source-parses registerTool()
 * calls, never actually runs the code) can catch this class of bug. This
 * script is the runtime complement: for each plugin, install ONLY its
 * production dependencies (mirroring Dockerfile.openclaw's per-plugin `npm
 * install --omit=dev`), load the plugin in an isolated `tsx` process, and
 * assert it registers exactly the tools it declares in
 * `openclaw.plugin.json#contracts.tools`.
 *
 * Why more than just `import("./index.ts")`: a sibling change made
 * pinchy-email import its adapters LAZILY (dynamic `import()` at dispatch
 * time), specifically so a broken *optional* provider dependency doesn't
 * crash the whole plugin's tool list. That means importing only index.ts
 * would never exercise gmail-adapter.ts/graph-adapter.ts/imap-adapter.ts and
 * would miss the exact bug class above. Instead this script walks the
 * plugin's own import graph from index.ts — both static imports and dynamic
 * `import()` calls, see scripts/lib/smoke-load-plugins.mjs's
 * `discoverReachableModules` — and imports every module actually reachable
 * from the entry point. That deliberately excludes standalone dev-tooling
 * scripts some plugins ship alongside their runtime code (e.g.
 * pinchy-files/generate-test-fixtures.ts, run manually via `npx tsx` and
 * never loaded by OpenClaw) which may import devDependencies that would
 * otherwise falsely fail this gate.
 *
 * Mechanism for production-dependency isolation: for each plugin with at
 * least one entry in `dependencies` (package.json), copy its manifest
 * (+ lockfile, if present) into an isolated temp directory, run `npm install
 * --omit=dev --no-audit --no-fund` there, copy the plugin's own non-test
 * source files alongside the resulting `node_modules`, then run a small
 * generated harness through `tsx` from that directory. Node's module
 * resolution walks up from the importing file's own directory, so the copied
 * modules resolve bare specifiers (e.g. "googleapis") ONLY from that
 * `--omit=dev` install — never from the repo's own hoisted devDependencies —
 * which is exactly what makes this gate able to catch a "should be a
 * dependency, not a devDependency" mistake. Plugins with no production
 * dependencies (pinchy-audit, pinchy-context, pinchy-docs, pinchy-transcript)
 * skip the install step (Dockerfile.openclaw doesn't run one for them
 * either) but still get their modules smoke-imported.
 *
 * Exit code 0 = every plugin smoke-loads and matches its declared tools;
 * 1 = at least one plugin failed to load or its registered tools drifted
 * from contracts.tools.
 */

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  discoverPluginDirs,
  hasIndexEntry,
  readDeclaredTools,
  hasProdDependencies,
  discoverReachableModules,
  compareToolSets,
} from "./lib/smoke-load-plugins.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_ROOT = join(REPO_ROOT, "packages", "plugins");
const IS_WINDOWS = process.platform === "win32";

// Generic stub plugin config satisfying every plugin's register()-time
// truthy checks (apiBaseUrl/gatewayToken presence, an `agents` map, etc.)
// without modelling any single plugin's exact config shape. Every real
// plugin either reads these fields optionally (`config?.apiBaseUrl ?? ""`)
// or bails out of register() entirely when they're falsy (pinchy-audit,
// pinchy-context, pinchy-docs, pinchy-transcript) — this object is truthy
// and non-empty everywhere so every plugin proceeds past those checks and
// actually calls registerTool()/on().
const STUB_PLUGIN_CONFIG = {
  apiBaseUrl: "http://smoke-load.invalid",
  gatewayToken: "smoke-load-token",
  agents: {},
  connectionId: "smoke-load-connection",
  docsPath: "/nonexistent/smoke-load-docs",
  publicBaseUrl: "http://smoke-load.invalid",
};

/**
 * Locate a `tsx` binary to run the harness with. Plugins run via OpenClaw's
 * own globally-installed `tsx` in production (see Dockerfile.openclaw); this
 * repo doesn't vendor tsx at the root, only under packages/web, with pnpm's
 * hoisted store as a fallback.
 */
function resolveTsxBin() {
  const binName = IS_WINDOWS ? "tsx.CMD" : "tsx";
  const candidates = [
    join(REPO_ROOT, "packages", "web", "node_modules", ".bin", binName),
    join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", binName),
    join(REPO_ROOT, "node_modules", ".bin", binName),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `Could not find a "tsx" binary in any of:\n${candidates.join("\n")}\nRun pnpm install first.`,
    );
  }
  return found;
}

/** Run a child process, buffering stdout+stderr, resolving instead of rejecting. */
function run(cmd, args, opts) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: IS_WINDOWS, ...opts });
    } catch (err) {
      resolvePromise({ status: 1, output: String(err) });
      return;
    }
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => resolvePromise({ status: 1, output: `${output}\n${err}` }));
    child.on("close", (status) => resolvePromise({ status, output }));
  });
}

/**
 * Build the source of the generated `tsx` harness for one plugin. Plain JS
 * (not TS) so tsx's loader hooks the process before any plugin `.ts` file is
 * imported. Written to a temp file next to the copied plugin source, then run
 * with `tsx <file>` from that directory.
 * @param {{ entryPath: string, extraPaths: string[] }} params
 */
function buildHarnessSource({ entryPath, extraPaths }) {
  const payload = { entry: entryPath, extras: extraPaths, pluginConfig: STUB_PLUGIN_CONFIG };
  return `import { pathToFileURL } from "node:url";

const PAYLOAD = ${JSON.stringify(payload)};

const registered = [];
const stubApi = {
  pluginConfig: PAYLOAD.pluginConfig,
  registerTool(factory, opts) {
    const name = (opts && opts.name) || (typeof factory === "function" ? factory.name : undefined);
    if (name) registered.push(name);
  },
  on() {},
  logger: { warn() {}, error() {}, info() {}, debug() {} },
  runtime: {
    modelAuth: { resolveApiKeyForProvider: async () => null },
    config: { loadConfig: () => ({}) },
    subagent: { run: async () => ({}) },
  },
};

const errors = [];

try {
  const mod = await import(pathToFileURL(PAYLOAD.entry).href);
  const plugin = mod.default ?? mod;
  if (!plugin || typeof plugin.register !== "function") {
    errors.push("plugin module has no default export with a register() function");
  } else {
    await plugin.register(stubApi);
  }
} catch (err) {
  errors.push("index.ts failed to load: " + (err && err.stack ? err.stack : String(err)));
}

for (const modulePath of PAYLOAD.extras) {
  try {
    await import(pathToFileURL(modulePath).href);
  } catch (err) {
    errors.push(modulePath + " failed to import: " + (err && err.message ? err.message : String(err)));
  }
}

process.stdout.write(JSON.stringify({ registered, errors }));
`;
}

/**
 * Smoke-load a single plugin. Never throws — failures are reported in the
 * returned result's `status`/`note`.
 * @param {string} pluginDir
 * @returns {Promise<{ rel: string, status: "pass"|"fail"|"skip", note: string }>}
 */
async function smokeLoadPlugin(pluginDir) {
  const rel = relative(REPO_ROOT, pluginDir);

  if (!hasIndexEntry(pluginDir)) {
    return { rel, status: "skip", note: "no index.ts entry point" };
  }

  const declaredTools = readDeclaredTools(pluginDir);
  if (declaredTools === null) {
    return { rel, status: "skip", note: "no contracts.tools in openclaw.plugin.json" };
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  } catch (err) {
    return { rel, status: "fail", note: `could not read package.json: ${err.message}` };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "smoke-load-plugins-"));
  try {
    // Copy every non-test .ts source file at the top level of the plugin dir
    // into the isolated temp dir, alongside the eventual --omit=dev
    // node_modules. Broad and cheap: unused siblings (dev-tooling scripts,
    // vitest configs) just sit there unimported — only modules actually
    // reachable from index.ts get import()ed below.
    const sourceFileNames = readdirSync(pluginDir).filter((name) => {
      if (!name.endsWith(".ts") || name.endsWith(".d.ts") || name.endsWith(".test.ts")) {
        return false;
      }
      return statSync(join(pluginDir, name)).isFile();
    });
    for (const name of sourceFileNames) {
      copyFileSync(join(pluginDir, name), join(tempDir, name));
    }

    if (hasProdDependencies(pkg)) {
      copyFileSync(join(pluginDir, "package.json"), join(tempDir, "package.json"));
      const lockPath = join(pluginDir, "package-lock.json");
      if (existsSync(lockPath)) copyFileSync(lockPath, join(tempDir, "package-lock.json"));

      const install = await run(
        "npm",
        ["install", "--omit=dev", "--no-audit", "--no-fund"],
        { cwd: tempDir },
      );
      if (install.status !== 0) {
        return {
          rel,
          status: "fail",
          note: `npm install --omit=dev failed (exit ${install.status}):\n${install.output}`,
        };
      }
    }

    const reachable = discoverReachableModules(pluginDir).map((absPath) =>
      join(tempDir, relative(pluginDir, absPath)),
    );
    const entryPath = join(tempDir, "index.ts");
    const extraPaths = reachable.filter((p) => p !== entryPath);

    const harnessPath = join(tempDir, "__smoke_harness.mjs");
    writeFileSync(harnessPath, buildHarnessSource({ entryPath, extraPaths }));

    const tsxBin = resolveTsxBin();
    const harnessRun = await run(tsxBin, [harnessPath], { cwd: tempDir });

    if (harnessRun.status !== 0) {
      return {
        rel,
        status: "fail",
        note: `smoke-load harness process exited ${harnessRun.status}:\n${harnessRun.output}`,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(harnessRun.output);
    } catch (err) {
      return {
        rel,
        status: "fail",
        note: `could not parse harness output (${err.message}):\n${harnessRun.output}`,
      };
    }

    if (parsed.errors.length > 0) {
      return { rel, status: "fail", note: `module import error(s):\n${parsed.errors.join("\n")}` };
    }

    const comparison = compareToolSets(parsed.registered, declaredTools);
    if (!comparison.ok) {
      const parts = [];
      if (comparison.missing.length > 0) {
        parts.push(
          `declared in contracts.tools but never registered: ${comparison.missing.join(", ")}`,
        );
      }
      if (comparison.extra.length > 0) {
        parts.push(`registered but missing from contracts.tools: ${comparison.extra.join(", ")}`);
      }
      return { rel, status: "fail", note: parts.join("; ") };
    }

    return {
      rel,
      status: "pass",
      note: `${declaredTools.length} tool(s) registered and matched contracts.tools`,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const dirs = discoverPluginDirs(PLUGINS_ROOT);
if (dirs.length === 0) {
  console.error(`No plugin packages found under ${relative(REPO_ROOT, PLUGINS_ROOT)}`);
  process.exit(1);
}

// Every plugin is independent (its own isolated temp dir/install), so run
// them concurrently — overall wall time is roughly the slowest single
// plugin's `npm install --omit=dev` rather than the sum of all of them.
const results = await Promise.all(
  dirs.map((dir) =>
    smokeLoadPlugin(dir).catch((err) => ({
      rel: relative(REPO_ROOT, dir),
      status: "fail",
      note: `unexpected error: ${err && err.stack ? err.stack : String(err)}`,
    })),
  ),
);

let failed = false;
for (const { rel, status, note } of results) {
  const icon = status === "pass" ? "✔" : status === "skip" ? "•" : "✖";
  console.log(`${icon} ${rel}: ${note}`);
  if (status === "fail") failed = true;
}

if (failed) {
  console.error("\n✖ Plugin smoke-load failed for one or more plugins (see ✖ above).");
  process.exit(1);
}

console.log(`\n✔ All ${dirs.length} plugin packages smoke-loaded cleanly with production-only dependencies.`);

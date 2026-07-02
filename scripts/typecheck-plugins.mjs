#!/usr/bin/env node
/**
 * Typecheck gate for the packages/plugins/pinchy-* plugin packages.
 *
 * The plugins run via tsx at runtime with no ahead-of-time type checking
 * anywhere else in CI (root `pnpm build` only typechecks packages/web via
 * `next build`; Dockerfile.openclaw only `npm install`s each plugin's deps).
 * This script runs `tsc --noEmit` against every plugin's own tsconfig — which
 * (see scripts/lib/plugin-typecheck.mjs) is wired to cover production *and*
 * test files, so vitest `expectTypeOf` contract tests become real compile-time
 * checks instead of runtime no-ops.
 *
 * Plugins are auto-discovered, so a new plugin is picked up with no edit here.
 * The companion drift guard (scripts/lib/plugin-typecheck.test.mjs, run by
 * `pnpm test:scripts`) fails fast if a plugin's tsconfig/package.json isn't
 * wired correctly, before this slower, install-dependent gate ever runs.
 *
 * The `tsc` runs themselves are launched concurrently (each plugin is an
 * independent compiler process) so overall wall time is roughly the slowest
 * single plugin rather than the sum of all of them. Output is still printed
 * per plugin, in the same sorted order as discovery, so the log stays
 * deterministic regardless of which process finishes first.
 *
 * Exit code 0 = all plugins typecheck; 1 = at least one failed or is
 * misconfigured.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  discoverPluginDirs,
  validatePluginDir,
} from "./lib/plugin-typecheck.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_ROOT = join(REPO_ROOT, "packages", "plugins");
const IS_WINDOWS = process.platform === "win32";

const dirs = discoverPluginDirs(PLUGINS_ROOT);
if (dirs.length === 0) {
  console.error(`No plugin packages found under ${relative(REPO_ROOT, PLUGINS_ROOT)}`);
  process.exit(1);
}

const failed = [];

// Fail fast on misconfiguration (the drift guard's rules) for every plugin
// BEFORE spawning any tsc process, so a wiring problem is reported as a clear
// "wire the tsconfig" message rather than getting lost among concurrent tsc
// output.
const runnable = [];
for (const dir of dirs) {
  const rel = relative(REPO_ROOT, dir);

  const problems = validatePluginDir(dir);
  if (problems.length > 0) {
    console.error(`✖ ${rel}: ${problems.join("; ")}`);
    failed.push(rel);
    continue;
  }

  const tscBin = join(
    dir,
    "node_modules",
    ".bin",
    IS_WINDOWS ? "tsc.CMD" : "tsc",
  );
  if (!existsSync(tscBin)) {
    console.error(
      `✖ ${rel}: typescript is not installed for this plugin (expected ${relative(
        REPO_ROOT,
        tscBin,
      )}). Add "typescript" to its devDependencies and run pnpm install.`,
    );
    failed.push(rel);
    continue;
  }

  runnable.push({ dir, rel, tscBin });
}

/**
 * Run `tsc --noEmit` for one plugin, buffering stdout/stderr instead of
 * inheriting them, so concurrent runs don't interleave their output.
 * @param {{ dir: string, rel: string, tscBin: string }} entry
 * @returns {Promise<{ rel: string, status: number|null, output: string }>}
 */
function runTsc({ dir, rel, tscBin }) {
  return new Promise((resolvePromise) => {
    const child = spawn(tscBin, ["--noEmit", "-p", "tsconfig.json"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: IS_WINDOWS,
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    child.on("close", (status) => {
      resolvePromise({ rel, status, output });
    });
  });
}

const results = await Promise.all(runnable.map(runTsc));

// Print in the original sorted (discovery) order so the log is deterministic
// no matter which tsc process finished first.
for (const { rel, status, output } of results) {
  console.log(`• typechecking ${rel} …`);
  if (output) {
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  }
  if (status !== 0) {
    failed.push(rel);
  }
}

if (failed.length > 0) {
  console.error(`\n✖ Plugin typecheck failed for: ${failed.join(", ")}`);
  process.exit(1);
}

console.log(`\n✔ All ${dirs.length} plugin packages typecheck cleanly.`);
